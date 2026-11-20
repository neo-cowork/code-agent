// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { EnvAssistNotice } from '../../../src/shared/contract/envAssist';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { applyConversationStreamEvent } from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';
import { envParkedTurnDuration } from '../../../src/renderer/utils/envParkedTurn';
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
    // park starts at the parked call (3000), ends at the first resumed message (305000): (315000 - 1000) - (305000 - 3000) = 12s
    expect(text).toBe('用时 12s');
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
    expect(screen.getByRole('button', { name: /用时/ }).textContent).toBe('用时 9s'); // (315000 - 1000) - (308000 - 3000): bounded by the first resumed trace node
  });

  it('a parallel pre-park call draining its result after the card does not end the parked span', () => {
    const messages = history();
    messages[1].toolCalls!.push({ id: 'parallel-status', name: 'calendar', arguments: { action: 'get_status' } });
    messages.splice(3, 0, { id: 'parallel-result', role: 'tool', content: '', timestamp: 5_005,
      toolResults: [{ toolCallId: 'parallel-status', success: true, output: 'status' }] });
    store(messages);
    render(<TurnCard turn={project(messages)} sessionId={SESSION} forceExpanded />);
    expect(screen.getByRole('button', { name: /用时/ }).textContent).toBe('用时 12s');
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
    expect(screen.getByRole('button', { name: /Worked for/ }).textContent).toBe('Worked for 12s');
  });
});

describe('parked span starts at the parked call under live message shapes', () => {
  beforeEach(() => {
    useAppStore.setState({ disclosureLevel: 'simple', language: 'zh', processingSessionIds: new Set(), isProcessing: false });
  });
  afterEach(() => {
    cleanup();
    useSessionStore.setState({ currentSessionId: null, messages: [], sessions: [] });
  });
  const duration = () => screen.getByRole('button', { name: /用时/ }).textContent;

  it('parked call carried only by a stream-recovery message (its tool node is dropped) still starts the span at the call', () => {
    const messages = history();
    // the real carrier (3000) is dropped as interrupted; only the recovery copy of the same call (4000) survives as a node
    messages.splice(2, 0, { ...messages[1], id: 'recovery-carrier', timestamp: 4_000,
      metadata: { streamRecovery: { turnId: 'old' } } } as Message);
    messages.splice(4, 1); // no recovery tool row yet (index 4 = original recovery tool row)
    store(messages);
    const turn = project(messages);
    expect(turn.nodes.filter(n => n.toolCall?.id === 'parked-call').every(n => n.timestamp === 4_000)).toBe(true);
    render(<TurnCard turn={turn} sessionId={SESSION} forceExpanded />);
    expect(duration()).toBe('用时 9s'); // (315000 - 1000) - (308000 - 3000): no recovery row, ends at the first resumed assistant; not the 314s wall clock
  });

  it('parked tool row whose result carries the env notice is dropped from the trace; span still starts at the call', () => {
    const messages = history();
    messages[3] = { ...messages[3], toolResults: [{ toolCallId: 'parked-call', success: false,
      error: 'waiting', metadata: { envAssist: notice } }] } as Message;
    store(messages);
    const turn = project(messages);
    expect(turn.nodes.some(n => n.toolCall?.id === 'parked-call')).toBe(false);
    render(<TurnCard turn={turn} sessionId={SESSION} forceExpanded />);
    expect(duration()).toBe('用时 12s');
  });

  it.each(['needs_user', 'resolved'] as const)('notice phase %s gives the same span', phase => {
    const messages = history();
    messages[2] = { ...messages[2], metadata: { envAssist: { ...notice, phase } } };
    store(messages);
    render(<TurnCard turn={project(messages)} sessionId={SESSION} forceExpanded />);
    expect(duration()).toBe('用时 12s');
  });

  it('replays the saved real rows: header excludes the whole park (~24s, not 1m40s or 4m5s)', () => {
    const base = 1795139517602;
    const ok = (callId: string, ms: number) => ({ toolCallId: callId, success: true, output: 'ok', duration: ms });
    const rows: Message[] = [
      { id: 'u', role: 'user', content: '明天日历上有什么安排', timestamp: base },
      { id: 'a1', role: 'assistant', content: '', timestamp: 1795139523035,
        toolCalls: [{ id: 'parked-call', name: 'calendar', arguments: { action: 'list_events' } }] },
      { id: 'n', role: 'assistant', content: '', timestamp: 1795139599391,
        metadata: { envAssist: { ...notice, phase: 'resolved', updatedAt: 1795139599391 } } },
      { id: 't1', role: 'tool', content: '', timestamp: 1795139744348, toolResults: [{ toolCallId: 'parked-call', success: false,
        error: 'interrupted: process crashed before a result was recorded; do not assume it ran or succeeded' }] },
      { id: 'a2', role: 'assistant', content: '', timestamp: 1795139748975,
        toolCalls: [{ id: 's', name: 'calendar', arguments: { action: 'get_status' } }] },
      { id: 't2', role: 'tool', content: '', timestamp: 1795139749057, toolResults: [ok('s', 6)] },
      { id: 'a3', role: 'assistant', content: '', timestamp: 1795139750434,
        toolCalls: [{ id: 'l', name: 'calendar', arguments: { action: 'list_events' } }] },
      { id: 't3', role: 'tool', content: '', timestamp: 1795139759695, toolResults: [ok('l', 9136)] },
      { id: 'f', role: 'assistant', content: '明天没有日程。', timestamp: 1795139762778 },
    ];
    store(rows);
    render(<TurnCard turn={project(rows)} sessionId={SESSION} forceExpanded />);
    expect(duration()).toBe('用时 23s'); // 23863ms floors to 23s; 245176 - (1795139744348 - 1795139523035) = 23863ms
  });
});

describe('persisted calendar permission park across runs', () => {
  const sessionId = 'session_1795177181906_badabcf6';
  const runId = 'run-579e2b22-00b5-43e5-802a-630b10464653';
  const noticeId = `${runId}|perm_calendars|calendar`;
  const callId = 'call_59c91e8f7a7342599e2eddd2';
  const carrierId = '9f2a4778-83a0-405e-b513-8304b982ce0d';
  const parkedAt = 1795177279496;
  const calendarNotice: EnvAssistNotice = {
    id: noticeId, sessionId, runId, class: 'perm_calendars',
    target: { id: 'calendar', labelKey: 'env.target.calendar' },
    phase: 'needs_user', sentenceKey: 'env.sentence.calendar',
    action: { kind: 'request_grant', labelKey: 'env.allow.calendar', payload: { pane: 'calendars' } },
    resume: { mode: 'manual' }, updatedAt: parkedAt, parkedToolCallId: callId,
  };
  const parkedCard: Message = {
    id: `env-assist:${noticeId}`, role: 'assistant', content: '', timestamp: parkedAt,
    metadata: { envAssist: calendarNotice, correlation: {
      turnId: '3a461842-8ea0-4643-92ad-ccc38da4ca03', traceId: '5416fda8b89a21fea45ed16eaf5cd9ee',
    } },
  };

  function calendarRows(): Message[] {
    const { action: _action, ...rest } = calendarNotice;
    const resolvedCard: Message = {
      ...parkedCard, metadata: { ...parkedCard.metadata, envAssist: {
        ...rest, phase: 'resolved', doneKey: 'env.done.calendar', updatedAt: 1795177471675,
      } },
    };
    const events = { action: 'list_events', from_local: '2026-11-21 00:00', to_local: '2026-11-21 23:59' };
    const statusId = 'call_94f5c633eeab4b92913e8d0a';
    const eventsId = 'call_1fabfcba0e774edcada64085';
    const status = { toolCallId: statusId, success: true, output: '已允许访问日历。', duration: 24 };
    const result = { toolCallId: eventsId, success: true, output: '没有找到匹配的日历事件。', duration: 5503 };
    // Row 13375 is the permission notice itself. Only relevant metadata and tool output are retained.
    return [
      { id: '6d097cdf-b604-45fd-b26f-e8b56a822c98', role: 'user', content: '明天日历上有什么安排', timestamp: 1795177189887 },
      { id: carrierId, role: 'assistant', content: '', timestamp: 1795177197183, thinking: '查询日历。',
        toolCalls: [{ id: callId, name: 'calendar', arguments: events }],
        contentParts: [{ type: 'text', text: '' }, { type: 'tool_call', toolCallId: callId }],
        metadata: { correlation: parkedCard.metadata?.correlation } },
      resolvedCard,
      { id: `${carrierId}:interrupted-tool-result:${callId}`, role: 'tool', content: '', timestamp: 1795177472760,
        toolResults: [{ toolCallId: callId, success: false, duration: 0,
          error: 'interrupted: process crashed before a result was recorded; do not assume it ran or succeeded' }] },
      { id: '40bce46f-9289-46d2-8612-9cc52de29642', role: 'assistant', content: '', timestamp: 1795177480963,
        toolCalls: [{ id: statusId, name: 'calendar', arguments: { action: 'get_status' }, result: status }],
        contentParts: [{ type: 'text', text: '' }, { type: 'tool_call', toolCallId: statusId }],
        metadata: { correlation: { turnId: '9df5698d-31eb-4c08-9de3-a9ab3523f86a' } } },
      { id: '56433d19-bb6c-4e3d-8fd1-8ac74b9c34ff', role: 'tool', content: '', timestamp: 1795177481498, toolResults: [status] },
      { id: '3c39f45f-47b7-47a6-976b-59a4aad3648d', role: 'assistant', content: '', timestamp: 1795177483688,
        toolCalls: [{ id: eventsId, name: 'calendar', arguments: events, result }],
        contentParts: [{ type: 'text', text: '' }, { type: 'tool_call', toolCallId: eventsId }],
        metadata: { correlation: { turnId: 'd75b59d5-3d01-432a-a324-409a0cc0a6b5' } } },
      { id: '0f756feb-1070-47ec-9a38-41677564ca16', role: 'tool', content: '', timestamp: 1795177489376, toolResults: [result] },
      { id: '4314d248-3c97-4f5e-a297-709ae52634d5', role: 'assistant', content: '明天（11月21日，周六）日历上没有任何安排，是空闲的一天。', timestamp: 1795177490787 },
    ];
  }

  beforeEach(() => {
    useAppStore.setState({ disclosureLevel: 'simple', language: 'zh', processingSessionIds: new Set(), isProcessing: false });
  });
  afterEach(() => {
    cleanup();
    useSessionStore.setState({ currentSessionId: null, messages: [], sessions: [] });
  });

  function renderFolded(rows: Message[], label: string) {
    const messages = hydrateToolCallResults(rows);
    useSessionStore.setState({ currentSessionId: sessionId, messages });
    const turn = projectTurns(messages, sessionId, false).turns[0];
    render(<TurnCard turn={turn} sessionId={sessionId} />);
    const header = screen.getByRole('button', { name: /用时/ });
    console.log(label, JSON.stringify({
      nodes: turn.nodes.map(node => [node.type, node.timestamp, node.toolCall?.id, node.metadata?.envAssist?.parkedToolCallId]),
      hasEnvPark: turn.nodes.some(node => node.metadata?.envAssist?.parkedToolCallId),
      header: header.textContent,
    }));
    expect(header.getAttribute('aria-expanded')).toBe('false');
    return header.textContent;
  }

  it('shows active time after reloading the resolved SQLite history', () => {
    expect(renderFolded(calendarRows(), 'calendar SQLite replay')).toBe('用时 1m 47s');
  });

  it('shows time through the park point while the calendar card is waiting', () => {
    const messages = hydrateToolCallResults([...calendarRows().slice(0, 2), parkedCard]);
    const turn = projectTurns(messages, sessionId, false).turns[0];
    const elapsed = envParkedTurnDuration(turn, messages);
    console.log('calendar still parked, elapsed ms:', elapsed);
    expect(elapsed).toBe(89_609);
  });

  it('shows wall-clock time for the same calendar work without a park', () => {
    expect(renderFolded(calendarRows().filter(row => row.id !== parkedCard.id), 'calendar without park')).toBe('用时 5m 0s');
  });

  it('shows active time when the persisted park card arrives on the live message stream', () => {
    const rows = calendarRows();
    useSessionStore.setState({ currentSessionId: sessionId, messages: rows.slice(0, 2) });
    const state = {
      currentTurnMessageId: carrierId, committedAssistantMessageIds: new Set<string>(),
      lastDeltaSeqByTurn: new Map(), segmentRedirectByTurn: new Map(),
    };
    const { addMessage, setMessages, updateMessage } = useSessionStore.getState();
    const actions = {
      getMessages: () => useSessionStore.getState().messages,
      addMessage, setMessages, updateMessage,
      queueUpdate: () => {},
      now: () => parkedAt,
    };
    applyConversationStreamEvent({ type: 'message', data: parkedCard }, state, actions);
    applyConversationStreamEvent({ type: 'message', data: parkedCard }, state, actions);
    const messages = actions.getMessages();
    expect(renderFolded([...messages, ...rows.slice(3)], 'calendar live park replay')).toBe('用时 1m 47s');
    expect(messages.filter(row => row.id === parkedCard.id)).toHaveLength(1);
    expect(messages.find(row => row.id === carrierId)?.timestamp).toBe(rows[1].timestamp);
  });
});
