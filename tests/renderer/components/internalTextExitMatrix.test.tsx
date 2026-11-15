// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { detectInternalTextLeaks } from '../../../src/shared/internalTextLeakDetect';
import { languages, type Language } from '../../../src/renderer/i18n';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { TaskDashboardSummary } from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';
import { CronJobList } from '../../../src/renderer/components/features/cron/CronJobList';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { ModelSwitcher } from '../../../src/renderer/components/StatusBar/ModelSwitcher';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { TurnTimelineNodeRenderer } from '../../../src/renderer/components/features/chat/TraceTimelineNodes';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { AgentErrorPresentation } from '../../../src/renderer/components/features/chat/AgentErrorCard';
import { TaskStatusBar } from '../../../src/renderer/components/features/chat/TaskStatusBar';
import { BackgroundSessionPanel } from '../../../src/renderer/components/features/background/BackgroundSessionPanel';
import { ToastContainer } from '../../../src/renderer/components/Toast';
import { humanizeToolStep, humanizeToolGroupLabel } from '../../../src/renderer/utils/humanizeToolStep';
import { getDisplaySessionTitle } from '../../../src/renderer/utils/sessionPresentation';
import { sanitizeNotificationText } from '../../../src/host/services/infra/notificationPolicy';
import { formatNativeModelSwitcherTooltip, formatExternalModelSwitcherTooltip } from '../../../src/renderer/components/StatusBar/modelSwitcherTooltips';

const runtime = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/host/session/sessionTitleHostPrompt', () => ({ readUiLanguage: () => runtime.language }));

// Shapes taken from realrun messages/tool_execution_events and background/session rows.
// ASCII user data makes every CJK character in an English render a chrome defect.
const slug = 'weekly-report-synthesis';
const recordId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const title = `Weekly report · ${recordId}`;
const skillNode: TraceNode = {
  id: 'skill-node', type: 'tool_call', content: '', timestamp: 1,
  toolCall: { id: 'call_weekly123', name: 'Skill', args: { command: slug }, success: false, result: 'Skill not found' },
};

function visibleChrome(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll('details:not([open])')) {
    for (const child of [...details.children]) if (child.tagName !== 'SUMMARY') child.remove();
  }
  // Text-node boundaries must survive scanning: a count next to a pill otherwise becomes
  // `1weekly-report-synthesis`, incorrectly passing the identifier word boundary.
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  const segments: string[] = [];
  while (walker.nextNode()) segments.push(walker.currentNode.textContent ?? '');
  return [segments.join(' '), ...[...copy.querySelectorAll('*')].flatMap((el) =>
    ['title', 'aria-label', 'placeholder'].map((attr) => el.getAttribute(attr) ?? ''))].join(' ');
}

function assertClean(exit: string, text: string, language: Language) {
  expect(text.trim().length, `${exit} must be exercised`).toBeGreaterThan(0);
  const leaks = detectInternalTextLeaks(text, language);
  const tags = text.match(/<(?:decision|rationale|evidence|cron_event_decision)\b[^>]*>/g) ?? [];
  const red = [...leaks.map((hit) => `${hit.format}: ${hit.sample}`), ...tags];
  if (red.length) throw new Error(`[exit-matrix ${language}/${exit}] ${red.join(' | ')}`);
}

beforeEach(() => {
  useAppStore.setState({ developerMode: false, cloudUIStrings: {} });
  useTaskStore.setState({ initialized: true, sessionStates: {}, stats: { running: 0, queued: 0, available: 3, maxConcurrent: 3 } });
  useSessionStore.setState({ sessions: [], backgroundSessions: [], runningSessionIds: new Set() });
  useToastStore.setState({ toasts: [] });
});
afterEach(() => { cleanup(); useSessionStore.setState({ backgroundSessions: [] }); });

describe.each(['zh', 'en'] as const)('seven user-visible exits (%s)', (language) => {
  beforeEach(() => { runtime.language = language; useAppStore.setState({ language }); });
  const t = languages[language];

  it('1 tool card, status variants and grouped line', () => {
    const { container } = render(<><ToolStepGroup nodes={[skillNode]} defaultExpanded /><ToolStepGroup nodes={[{ ...skillNode, id: 'skill-success', toolCall: { ...skillNode.toolCall!, id: 'skill-success-call', success: true, result: 'Done' } }]} defaultExpanded /></>);
    const statusLines = (['running', 'completed', 'failed'] as const).map((status) => humanizeToolStep('Skill', { command: slug }, t, undefined, status));
    assertClean('tool-card', [visibleChrome(container), ...statusLines, humanizeToolGroupLabel(['Skill', 'Skill'], t)].join(' '), language);
  });
  it('1 timeline skill row', () => {
    const { container } = render(<TurnTimelineNodeRenderer node={{
      id: 'timeline', type: 'turn_timeline', content: '', timestamp: 1,
      turnTimeline: { id: 'timeline', kind: 'skill_activity', tone: 'neutral', timestamp: 1,
        skillActivity: { summary: `Skill 触发了 ${slug} skill`, items: [
          { skillId: slug, label: slug, action: 'triggered', timestamp: 1, detail: 'skill tool' },
        ] } },
    }} />);
    assertClean('timeline', visibleChrome(container), language);
  });
  it('1 production turn skill activity banner', () => {
    const { container } = render(<TurnCard turn={{
      turnNumber: 1, turnId: 'weekly-turn', status: 'completed', startTime: 1, endTime: 4,
      nodes: [{ id: 'request', type: 'user', timestamp: 1, content: 'Summarize the notes' }, skillNode,
        { id: 'timeline-banner', type: 'turn_timeline', timestamp: 2, content: '',
          turnTimeline: { id: 'skill-banner', kind: 'skill_activity', tone: 'neutral', timestamp: 2,
            skillActivity: { summary: `Skill 触发了 ${slug} skill`, items: [
              { skillId: slug, label: slug, action: 'triggered', timestamp: 2, detail: 'skill tool' },
            ] } } },
        { id: 'answer', type: 'assistant_text', timestamp: 3, content: 'Report ready.' }],
    }} />);
    assertClean('turn-skill-banner', visibleChrome(container), language);
    const toggle = container.querySelector('[data-testid="skill-activity-banner"] button');
    if (!toggle) throw new Error('production skill banner toggle missing');
    fireEvent.click(toggle);
    assertClean('turn-skill-banner-expanded', visibleChrome(container), language);
  });
  it('1 expanded hook tool names use the shared humanizer', () => {
    const { container } = render(<TurnTimelineNodeRenderer node={{
      id: 'hook-timeline', type: 'turn_timeline', timestamp: 1, content: '',
      turnTimeline: { id: 'hook', kind: 'hook_activity', tone: 'neutral', timestamp: 1,
        hookActivity: { summary: 'Hook activity', items: [{ timestamp: 1, event: 'PreToolUse', action: 'allow',
          hookCount: 1, durationMs: 1, sources: ['project'], hookType: 'decision', toolName: 'read_file', names: ['File check'] }] } },
    }} />);
    const toggle = container.querySelector('button');
    if (!toggle) throw new Error('production hook toggle missing');
    fireEvent.click(toggle);
    assertClean('hook-tool-name', visibleChrome(container), language);
  });
  it('2 error card from a raw failing connector event', () => {
    const { container } = render(<AgentErrorPresentation messageId="failed-mail" error={{
      category: 'generic', timestamp: 1,
      rawMessage: language === 'en' ? 'mcp__mail__list unavailable' : '连接器 mcp__mail__list 不可用',
    }} />);
    assertClean('error-card', visibleChrome(container), language);
  });
  it('3 system notification and renderer toast', () => {
    const body = `[completed] id=bg_42 · ${slug} · read_file`;
    useToastStore.setState({ toasts: [{ id: 'notice', type: 'success', message: body }] });
    const { container } = render(<ToastContainer />);
    assertClean('notification', `${sanitizeNotificationText(body)} ${visibleChrome(container)}`, language);
  });
  it('4 active task status bar', () => {
    useSessionStore.setState({ sessions: [{ id: 'weekly', title, messageCount: 1, turnCount: 1, modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' }, createdAt: 1, updatedAt: 1 }] });
    useTaskStore.setState({ sessionStates: { weekly: { status: 'running', startTime: Date.now() } }, stats: { running: 1, queued: 0, available: 3, maxConcurrent: 3 } });
    const { container } = render(<TaskStatusBar />);
    assertClean('status-bar', visibleChrome(container), language);
  });
  it('4 model status tooltip labels', () => {
    const base = { language, engineLabel: 'Neo', currentModel: 'Example', displayProvider: 'xiaomi' as const, displayModel: 'Example', adaptive: false, overridden: false };
    const copy = [false, true].flatMap((adaptive) => [false, true].map((overridden) => formatNativeModelSwitcherTooltip({ ...base, adaptive, overridden })));
    copy.push(formatExternalModelSwitcherTooltip({ language, engineLabel: 'External', model: 'Example' }));
    assertClean('model-status-tooltip', copy.join(' '), language);
  });
  it('4 opened model status control', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const invoke = vi.fn(async (_domain: string, action: string) => {
      if (action === 'get') return { success: true, data: { models: { default: 'xiaomi', providers: {
        xiaomi: { enabled: true, apiKeyConfigured: true, models: { 'mimo-v2.6-flash': { enabled: true } } },
      }, routing: {} } } };
      if (action === 'getModelOverride') return { success: true, data: null };
      if (action === 'listSources') return { success: true, data: [] };
      return { success: false, data: null };
    });
    Object.defineProperty(window, 'domainAPI', { configurable: true, value: { invoke } });
    try {
      if (language === 'en') useAppStore.setState({ language: 'zh' });
      const { container } = render(<ModelSwitcher currentModel="mimo-v2.6-flash" />);
      fireEvent.click(container.querySelector('button')!);
      await waitFor(() => expect(document.querySelector('[data-model-search-input]')).toBeTruthy());
      if (language === 'en') {
        await waitFor(() => expect(document.body.textContent).toContain('小米'));
        act(() => useAppStore.setState({ language: 'en' }));
      }
      assertClean('model-status-control', visibleChrome(document.body), language);
    } finally {
      delete (window as unknown as Record<string, unknown>).domainAPI;
    }
  });
  it('5 session and scheduled task names through the production presenter', () => {
    assertClean('session-task-names', [title, `[Schedule] ${title}`].map((raw) => getDisplaySessionTitle(raw, language)).join(' '), language);
  });
  it('5 scheduled list and background task names', () => {
    useCronStore.setState({ jobs: [{ id: 'weekly-job', name: title, runsOn: 'local', scheduleType: 'cron',
      schedule: { type: 'cron', expression: '0 9 * * 5' }, enabled: true,
      action: { type: 'agent', agentType: 'default', prompt: 'Summarize the notes' }, createdAt: 1, updatedAt: 1 }],
      latestExecutions: {}, searchQuery: '', locationFilter: 'all', isLoading: false });
    const { container } = render(<><CronJobList /><TaskDashboardSummary tasks={[{
      id: 'background-export', scope: 'global', title, status: 'in_progress', steps: [],
    }]} /></>);
    assertClean('task-lists', visibleChrome(container), language);
  });
  it('6 background panel completion row', () => {
    useSessionStore.setState({ backgroundSessions: [{ sessionId: 'export', title: 'Table export', status: 'completed', startedAt: 1, backgroundedAt: 2,
      completionMessage: '[completed] id=bg_42 · result was recorded · read_file' }] });
    const { container } = render(<BackgroundSessionPanel />);
    assertClean('background-panel', visibleChrome(container), language);
  });
  it('7 system-inserted reply and wake/event control text', () => {
    const nodes: TraceNode[] = [
      { id: 'system', type: 'system', timestamp: 1, content: `read_file · ${slug} · session_work123` },
      { id: 'wake', type: 'assistant_text', timestamp: 2, content: 'Report ready.<decision>report</decision><rationale>Review the summary.</rationale>' },
      { id: 'event', type: 'assistant_text', timestamp: 3, content: 'Mail checked.<cron_event_decision>Nothing to send.</cron_event_decision>' },
      { id: 'skill-status', type: 'system', subtype: 'skill_status', timestamp: 4, content: `<command-message>Loading skill: ${slug}</command-message><command-name>${slug}</command-name>` },
    ];
    const { container } = render(<>{nodes.map((node) => <TraceNodeRenderer key={node.id} node={node} />)}</>);
    assertClean('system-reply', visibleChrome(container), language);
  });
});
