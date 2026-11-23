// @vitest-environment jsdom
// 停车写入审批行的四种互斥状态：待批 / 超时 / 用户拒绝 / 真中断，行内只出现一个状态词。
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AgentFailureCode, HostReasonCode, type PermissionRequest } from '../../../src/shared/contract';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { en } from '../../../src/renderer/i18n/en';

const state = vi.hoisted(() => ({ pending: null as PermissionRequest | null, live: false }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (value: Record<string, unknown>) => unknown) => selector({
    resolvedPermissionRequests: {},
    pendingPermissionRequest: state.pending,
    pendingPermissionSessionId: state.pending ? 'session-1' : null,
    queuedPermissionRequests: {},
    processingSessionIds: state.live ? new Set(['session-1']) : new Set<string>(),
    openPreview: vi.fn(),
    openSettingsTab: vi.fn(),
  }),
}));
vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (value: { sendPrompt: () => void }) => unknown) => selector({ sendPrompt: vi.fn() }),
}));

import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';

const WORDS = {
  pending: en.toolStepHumanize.pendingApprovalStatus,
  denied: en.outcomeWords['failed-approval-denied'].timeline.reason,
  timeout: en.outcomeWords['failed-timeout'].timeline.reason,
  interrupted: 'Interrupted',
};

function writeNode(extra: Partial<NonNullable<TraceNode['toolCall']>>): TraceNode {
  return {
    id: 'node-w', type: 'tool_call', content: '', timestamp: 1,
    toolCall: { id: 'call-w', name: 'Write', args: { file_path: '/outside/summary-en.md', content: 'x' }, ...extra },
  } as TraceNode;
}

function failed(code: HostReasonCode): TraceNode {
  return writeNode({
    success: false,
    result: 'denied',
    metadata: {
      failureCode: AgentFailureCode.PermissionDenied,
      hostReason: { code, modelText: 'x' },
    },
  });
}

function rowText(node: TraceNode) {
  const { container } = render(<ToolStepGroup nodes={[node]} />);
  return container.textContent ?? '';
}

afterEach(() => { cleanup(); state.pending = null; state.live = false; });

describe('parked Write row states', () => {
  it('approval timed out: not-written title + timeout reason, no "denied"', () => {
    const text = rowText(failed(HostReasonCode.PermissionDeniedTimeout));
    expect(text).toContain(en.deliveryExperience.notWritten);
    expect(text).toContain('summary-en.md');
    expect(text).toContain(WORDS.timeout);
    expect(text).not.toContain(WORDS.denied);
    expect(text).not.toContain(WORDS.pending);
  });

  it('user denied: keeps the approval-denied reason', () => {
    const text = rowText(failed(HostReasonCode.PermissionDeniedByUser));
    expect(text).toContain(en.deliveryExperience.notWritten);
    expect(text).not.toContain(WORDS.timeout);
    expect(text).not.toContain(WORDS.pending);
  });

  it('pending approval: only "Approval needed", never interrupted/denied', () => {
    state.pending = {
      id: 'p1', sessionId: 'session-1', parentToolUseId: 'call-w', tool: 'Write', type: 'file_write',
      details: { path: '/outside/summary-en.md' } as PermissionRequest['details'], timestamp: 1,
    } as PermissionRequest;
    const text = rowText(writeNode({}));
    expect(text).toContain(WORDS.pending);
    expect(text).not.toContain(WORDS.interrupted);
    expect(text).not.toContain(WORDS.denied);
  });

  it('truly interrupted (no result, not live, nothing pending): "Interrupted", not approval wording', () => {
    const text = rowText(writeNode({}));
    expect(text).toContain(WORDS.interrupted);
    expect(text).not.toContain(WORDS.pending);
    expect(text).not.toContain(WORDS.denied);
  });
});
