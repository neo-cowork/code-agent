// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { EnvAssistNotice } from '../../../src/shared/contract/envAssist';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { hydrateToolCallResults } from '../../../src/renderer/utils/messageHydration';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const SESSION = 'env-resumed-session';
const notice = {
  id: 'calendar-notice', sessionId: SESSION, runId: 'env-run', class: 'perm_automation',
  target: { id: 'calendar', labelKey: 'env.target.calendar' }, phase: 'needs_user',
  sentenceKey: 'env.sentence.calendar', resume: { mode: 'manual' }, updatedAt: 5_000,
  parkedToolCallId: 'parked-call',
} as EnvAssistNotice;

function history(): Message[] {
  return [
    { id: 'user', role: 'user', content: '明天有什么日程？', timestamp: 1_000 },
    { id: 'old', role: 'assistant', content: '', timestamp: 3_000,
      toolCalls: [{ id: 'parked-call', name: 'calendar', arguments: { action: 'list_events' } }] },
    { id: 'notice', role: 'assistant', content: '', timestamp: 5_000, metadata: { envAssist: notice } },
    { id: 'recovery', role: 'tool', content: '', timestamp: 305_000,
      toolResults: [{ toolCallId: 'parked-call', success: false,
        error: 'interrupted: process crashed before a result was recorded; do not assume it ran or succeeded' }] },
    { id: 'new', role: 'assistant', content: '', timestamp: 308_000,
      toolCalls: [{ id: 'continued-call', name: 'calendar', arguments: { action: 'list_events' } }] },
    { id: 'result', role: 'tool', content: '', timestamp: 311_000,
      toolResults: [{ toolCallId: 'continued-call', success: true, output: '没有日程' }] },
    { id: 'final', role: 'assistant', content: '明天没有日程。', timestamp: 315_000 },
  ];
}
function project(messages = history()) {
  return projectTurns(hydrateToolCallResults(messages), SESSION, false).turns[0];
}
function store(messages: Message[]) {
  useSessionStore.setState({ currentSessionId: SESSION, messages: hydrateToolCallResults(messages) });
}

describe('environment parked turn continuation', () => {
  beforeEach(() => {
    useAppStore.setState({ disclosureLevel: 'simple', language: 'zh', processingSessionIds: new Set(), isProcessing: false });
  });
  afterEach(() => {
    cleanup();
    useSessionStore.setState({ currentSessionId: null, messages: [], sessions: [] });
  });

  it('resumed header discards only the parked call after the continuation succeeds (multi-node staleUnfinished)', () => {
    const turn = project();
    render(<ToolStepGroup nodes={turn.nodes.filter(n => n.toolCall)} turnNodes={turn.nodes} sessionId={SESSION} />);
    const text = screen.getByTestId('tool-group-head-label').textContent;
    console.log('multi-node staleUnfinished header:', text);
    expect(text).toBe('日历 · 查询了日程');
    expect(text).not.toContain('已中断');
  });

  it('finished TurnCard uses the final header even when the card separates the two tool groups', () => {
    store(history());
    render(<TurnCard turn={project()} sessionId={SESSION} forceExpanded />);
    expect(screen.queryByTestId('interrupt-timeline-step')).toBeNull();
    expect(screen.getByTestId('tool-group-head-label').textContent).toBe('日历 · 查询了日程');
  });

  it('excludes the synthetic five-minute park using the first raw resumed message, preserving execution on both sides', () => {
    store(history());
    render(<TurnCard turn={project()} sessionId={SESSION} forceExpanded />);
    const text = screen.getByRole('button', { name: /用时/ }).textContent;
    console.log('long-park turn duration:', text);
    expect(text).toBe('用时 14s'); // (315000 - 1000) - (305000 - 5000)
  });

  it('while parked the real env-waiting assembler has no interrupted word', () => {
    useSessionStore.setState({ currentSessionId: SESSION, sessions: [{ id: SESSION,
      durableResume: { runId: 'env-run', mode: 'continue', interruptCause: 'env_blocked',
        envBlocked: { class: 'perm_automation', target: 'calendar', toolCallId: 'parked-call' } },
    }] as never });
    render(<ToolStepGroup nodes={project().nodes.filter(n => n.toolCall).slice(0, 1)} sessionId={SESSION} />);
    const text = screen.getByTestId('tool-call-row-calendar').textContent;
    expect(text).toContain('等你允许日历');
    expect(text).not.toContain('已中断');
  });

  it('a normal turn keeps its completed header and wall-clock duration', () => {
    const messages = history().filter(m => ['user', 'new', 'result', 'final'].includes(m.id));
    store(messages);
    render(<TurnCard turn={project(messages)} sessionId={SESSION} forceExpanded />);
    expect(screen.getByTestId('tool-group-head-label').textContent).toBe('日历 · 查询了日程');
    expect(screen.getByRole('button', { name: /用时/ }).textContent).toBe('用时 5m 14s');
  });
});

describe('environment continuation ownership and time boundaries', () => {
  beforeEach(() => {
    useAppStore.setState({ disclosureLevel: 'simple', language: 'zh', processingSessionIds: new Set(), isProcessing: false });
  });
  afterEach(() => {
    cleanup();
    useSessionStore.setState({ currentSessionId: null, messages: [], sessions: [] });
    useAppStore.setState({ language: 'zh' });
  });

  it('the persisted exact parked ID keeps the waiting copy when the session projection has not arrived', () => {
    const messages = history().slice(0, 3);
    store(messages);
    render(<TurnCard turn={project(messages)} sessionId={SESSION} forceExpanded />);
    expect(screen.getByTestId('tool-call-row-calendar').textContent).toContain('等你允许日历');
    expect(screen.queryByTestId('interrupt-timeline-step')?.textContent).not.toContain('已中断');
  });

  it.each([undefined, 'user_stop', 'quota_wait', 'crash_or_quit'] as const)(
    'a loaded session with durable cause %s keeps the interrupted outcome despite the unresolved permission card', cause => {
      const messages = history().slice(0, 3);
      store(messages);
      useSessionStore.setState({ sessions: [{
        id: SESSION, title: '明日日程', createdAt: 1_000, updatedAt: 5_000,
        messageCount: 3, turnCount: 1, status: 'interrupted', modelConfig: useAppStore.getState().modelConfig,
        durableResume: cause ? { runId: 'env-run', mode: 'continue', interruptCause: cause,
          autoResumeCount: 0, maxAutoResumeCount: 3, canContinue: true } : undefined,
      }] });
      render(<ToolStepGroup nodes={project(messages).nodes.filter(n => n.toolCall)} sessionId={SESSION} />);
      const text = screen.getByTestId('tool-call-row-calendar').textContent;
      console.log(`loaded durable cause=${cause ?? 'absent'} row:`, text);
      expect(text).toContain('已中断');
      expect(text).not.toContain('等你允许');
    },
  );

  it('a parallel result draining after the card does not turn waiting into interrupted', () => {
    const messages = history().slice(0, 3);
    messages.push({ id: 'parallel-result', role: 'tool', content: '', timestamp: 5_005,
      toolResults: [{ toolCallId: 'parallel-status', success: true, output: 'status' }] });
    store(messages);
    render(<ToolStepGroup nodes={project(messages).nodes.filter(n => n.toolCall)} sessionId={SESSION} />);
    expect(screen.getByTestId('tool-call-row-calendar').textContent).toContain('等你允许日历');
    expect(screen.queryByTestId('interrupt-timeline-step')?.textContent).not.toContain('已中断');
  });

  it.each(['failed continuation', 'different action', 'different calendar', 'missing park ID', 'real original failure'])(
    '%s preserves the original outcome instead of claiming success', variant => {
      const messages = history();
      if (variant === 'failed continuation') messages[5].toolResults![0].success = false;
      if (variant === 'different action') messages[4].toolCalls![0].arguments.action = 'list_calendars';
      if (variant === 'different calendar') messages[4].toolCalls![0].arguments.calendar = 'Another calendar';
      if (variant === 'missing park ID') messages[2] = { ...messages[2], metadata: { envAssist: { ...notice, parkedToolCallId: undefined } } };
      if (variant === 'real original failure') messages[3].toolResults![0].error = 'calendar read failed';
      const turn = project(messages);
      render(<ToolStepGroup nodes={turn.nodes.filter(n => n.toolCall)} turnNodes={turn.nodes} sessionId={SESSION} />);
      expect(screen.getByTestId('tool-group-head-label').textContent).toMatch(/已中断|未成功/);
    },
  );

  it('an unrelated stale call is not folded away with the parked call', () => {
    const turn = project();
    const unrelated = { ...turn.nodes.find(n => n.toolCall)!, id: 'unrelated',
      toolCall: { id: 'other-call', name: 'Read', args: { file_path: '/work/notes.md' } } };
    turn.nodes.push(unrelated);
    render(<ToolStepGroup nodes={turn.nodes.filter(n => n.toolCall)} turnNodes={turn.nodes} sessionId={SESSION} />);
    expect(screen.getByTestId('tool-group-head-label').textContent).toContain('已中断');
  });

  it('keeps both calls while the continued turn is still streaming', () => {
    const turn = project();
    render(<ToolStepGroup nodes={turn.nodes.filter(n => n.toolCall)} turnNodes={turn.nodes} sessionId={SESSION} isStreamingTurn defaultExpanded />);
    expect(screen.getAllByTestId('tool-call-row-calendar')).toHaveLength(2);
  });

  it('missing raw history uses the first resumed trace node as the bounded fallback', () => {
    render(<TurnCard turn={project()} sessionId={SESSION} forceExpanded />);
    expect(screen.getByRole('button', { name: /用时/ }).textContent).toBe('用时 11s');
  });

  it('a parallel pre-park call draining its result after the card does not end the parked span', () => {
    const messages = history();
    messages[1].toolCalls!.push({ id: 'parallel-status', name: 'calendar', arguments: { action: 'get_status' } });
    messages.splice(3, 0, { id: 'parallel-result', role: 'tool', content: '', timestamp: 5_005,
      toolResults: [{ toolCallId: 'parallel-status', success: true, output: 'status' }] });
    store(messages);
    render(<TurnCard turn={project(messages)} sessionId={SESSION} forceExpanded />);
    expect(screen.getByRole('button', { name: /用时/ }).textContent).toBe('用时 14s');
  });

  it('ordinary permission-error notices never subtract time or reclassify an unrelated stale call', () => {
    const messages = history();
    messages[2] = { ...messages[2], metadata: { envAssist: { ...notice, parkedToolCallId: undefined } } };
    store(messages);
    render(<TurnCard turn={project(messages)} sessionId={SESSION} forceExpanded />);
    expect(screen.getByRole('button', { name: /用时/ }).textContent).toBe('用时 5m 14s');
    expect(screen.getByTestId('interrupt-timeline-step').textContent).toContain('已中断');
  });

  it('a later user turn cannot supply a successful continuation for the earlier park', () => {
    const messages = history();
    messages.splice(4, 0, { id: 'next-user', role: 'user', content: '再查一次', timestamp: 306_000 });
    store(messages);
    const earlier = project(messages);
    render(<TurnCard turn={earlier} sessionId={SESSION} forceExpanded />);
    expect(screen.getByTestId('interrupt-timeline-step').textContent).toContain('已中断');
  });

  it('English uses the completed action and the same active duration', () => {
    store(history());
    useAppStore.setState({ language: 'en' });
    render(<TurnCard turn={project()} sessionId={SESSION} forceExpanded />);
    expect(screen.getByTestId('tool-group-head-label').textContent).toBe('Calendar · Queried events');
    expect(screen.getByRole('button', { name: /Worked for/ }).textContent).toBe('Worked for 14s');
  });
});
