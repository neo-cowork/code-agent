// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import type { TurnSegment } from '../../../src/renderer/components/TaskPanel/SessionInspector/model';
import { humanizeToolFailureReason, resolveToolTerminalOutcomeKey } from '../../../src/renderer/utils/toolExecutionPresentation';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const ui = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/stores/appStore', () => {
  const state = {
    processingSessionIds: new Set<string>(),
    pendingPermissionRequest: null as Record<string, unknown> | null,
    pendingPermissionSessionId: null as string | null,
    queuedPermissionRequests: [] as Array<Record<string, unknown>>,
    openPreview: vi.fn(),
    workingDirectory: '/repo',
    get language() { return ui.language; },
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  };
  return {
    useAppStore: (selector?: (value: typeof state) => unknown) => (selector ? selector(state) : state),
  };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string | null; messages: never[] }) => unknown) => (
    selector({ currentSessionId: 'session-1', messages: [] })
  ),
}));

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { TurnRow } from '../../../src/renderer/components/TaskPanel/SessionInspector/turnRow';

afterEach(() => {
  cleanup();
  ui.language = 'zh';
});

function helperCard(failureCode: string, error: string): ToolCall {
  return {
    id: 'helper-step',
    name: 'Task',
    arguments: { description: 'Open the example pages' },
    result: {
      toolCallId: 'helper-step',
      success: false,
      error,
      metadata: { failureCode },
    },
  };
}

function failedTurn(error: string): TurnSegment {
  return {
    index: 1,
    events: [],
    stamp: {
      ts: 1,
      terminal: 'failed',
      verdict: 'n_a',
      evidenceCount: 0,
      evidenceProblems: [],
      source: 'generic',
    },
    inProgress: false,
    toolDispatches: [{
      toolName: 'Task',
      success: false,
      durationMs: 12,
      error,
      fromCache: false,
      bucket: 'other',
    }],
    decisions: [],
    inferences: [],
    manifests: [],
    verificationCount: 0,
    verificationSkippedCount: 0,
    compactionCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0 },
    toolCounts: { read: 0, write: 0, command: 0, browser: 0, other: 1 },
    failedToolCount: 1,
    tokenAnomaly: false,
    lastToolBucket: 'other',
    inferenceCalls: [],
    orphanToolDispatches: [],
    startedAt: 1,
    endedAt: 2,
  };
}

const CASES = [
  {
    name: 'step-cap zh',
    language: 'zh' as const,
    failureCode: 'step-cap-reached',
    error: 'Max iterations reached',
    card: '这次任务做到步数上限，已停下',
    badge: '步数上限',
    reason: '执行达到步数上限',
    outcome: 'failed-step-cap' as const,
    banned: /额度|预算|quota|budget/iu,
  },
  {
    name: 'step-cap en',
    language: 'en' as const,
    failureCode: 'step-cap-reached',
    error: 'Max iterations reached',
    card: 'This task reached its step limit and stopped',
    badge: 'Step limit',
    reason: 'The run reached its step limit',
    outcome: 'failed-step-cap' as const,
    banned: /额度|预算|quota|budget/iu,
  },
  {
    name: 'token-budget zh',
    language: 'zh' as const,
    failureCode: 'budget-exhausted',
    error: 'max token budget exhausted',
    card: '这次任务的额度已经用完',
    badge: '预算用尽',
    reason: '执行达到预算上限',
    outcome: 'failed-budget' as const,
    banned: null,
    required: /额度|预算/u,
  },
  {
    name: 'token-budget en',
    language: 'en' as const,
    failureCode: 'budget-exhausted',
    error: 'max token budget exhausted',
    card: 'This task used up its budget',
    badge: 'Budget exhausted',
    reason: 'The run reached its budget limit',
    outcome: 'failed-budget' as const,
    banned: null,
    required: /budget|quota/i,
  },
];

describe('step-cap card and inspector badge', () => {
  it.each(CASES)('$name', (item) => {
    ui.language = item.language;
    const t = item.language === 'zh' ? zh : en;
    const card = helperCard(item.failureCode, item.error);
    expect(humanizeToolFailureReason(card, t)).toBe(item.card);
    expect(resolveToolTerminalOutcomeKey(card)).toBe(item.outcome);
    if (item.banned) expect(humanizeToolFailureReason(card, t)).not.toMatch(item.banned);
    if (item.required) expect(humanizeToolFailureReason(card, t)).toMatch(item.required);

    const view = render(<ToolCallDisplay toolCall={card} index={0} total={1} />);
    expect(view.container.textContent).toContain(item.card);
    if (item.banned) expect(view.container.textContent).not.toMatch(item.banned);
    view.unmount();

    render(<TurnRow segment={failedTurn(item.error)} />);
    expect(screen.getByTestId('inspector-stamp').textContent).toContain(item.badge);
    expect(screen.getByTestId('inspector-stamp-reason').textContent).toBe(item.reason);
    const badgeText = `${screen.getByTestId('inspector-stamp').textContent} ${screen.getByTestId('inspector-stamp-reason').textContent}`;
    if (item.banned) expect(badgeText).not.toMatch(item.banned);
    if (item.required) expect(badgeText).toMatch(item.required);
  });
});
