// @vitest-environment jsdom
// FB-1683：被预检拦下、之后又成功的步骤，行标题不能同时写「未修改 · 文件」与「后续修改已成功」。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, ToolCall } from '../../../src/shared/contract';
import { AgentFailureCode } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const mocks = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: mocks.language === 'zh' ? zh : en }) }));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({ useAgentTreeSnapshot: () => ({ snapshot: null }) }));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({ useBackgroundTaskStore: (select: (s: unknown) => unknown) => select({ tasks: [] }) }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({ useSessionStore: (select: (s: unknown) => unknown) => select({ currentSessionId: 'session' }) }));
vi.mock('../../../src/renderer/stores/appStore', () => ({ useAppStore: (select: (s: unknown) => unknown) => select({ processingSessionIds: new Set(), queuedPermissionRequests: {}, pendingPermissionRequest: null, openPreview: vi.fn() }) }));
afterEach(() => { cleanup(); });

const EDIT_ARGS = { file_path: '/tmp/summary.md', edits: [{ old_text: '旧', new_text: '新' }] };

function failedCall(name: string, args: Record<string, unknown>, metadata: Record<string, unknown>): ToolCall {
  return { id: 'failed', name, arguments: args, result: { toolCallId: 'failed', success: false, error: 'blocked', metadata } };
}

const CASES = [
  { kind: 'edit', name: 'Edit', args: EDIT_ARGS, metadata: { code: 'NOT_READ' }, verbs: ['未修改', 'Not modified'] },
  { kind: 'write', name: 'Write', args: { file_path: '/tmp/summary.md', content: 'x' }, metadata: { code: 'NOT_READ_FOR_OVERWRITE' }, verbs: ['未写入', 'Not written'] },
  { kind: 'read', name: 'Read', args: { file_path: '/tmp/summary.md' }, metadata: { code: 'NOT_READ' }, verbs: ['未读取', 'Not read'] },
  { kind: 'bash', name: 'Bash', args: { command: 'ls' }, metadata: { failureCode: AgentFailureCode.PermissionDenied }, verbs: ['未执行', 'Not executed'] },
] as const;

// recovered 对这些行只表示「不再顶红」，步骤从未执行：预检标题必须保留。
const NEVER_EXECUTED = [
  { label: 'gate-bounced Edit under repair guard', name: 'Edit', args: EDIT_ARGS, metadata: { artifactRepairGuard: { blocked: true }, bounced: true }, verbs: ['未修改', 'Not modified'] },
  { label: 'repair-guard Bash', name: 'Bash', args: { command: 'ls' }, metadata: { artifactRepairGuard: { blocked: true } }, verbs: ['未执行', 'Not executed'] },
  { label: 'host-skipped Bash', name: 'Bash', args: { command: 'ls' }, metadata: { failureCode: AgentFailureCode.PermissionDenied, skipped: true }, verbs: ['未执行', 'Not executed'] },
] as const;

for (const locale of ['zh', 'en'] as const) {
  const idx = locale === 'zh' ? 0 : 1;
  describe(`recovered preflight row (${locale})`, () => {
    it.each(CASES)('$kind ToolCallDisplay: recovered hides the preflight verb, unrecovered keeps it', (c) => {
      mocks.language = locale;
      const verb = c.verbs[idx];
      const recovered = render(<ToolCallDisplay toolCall={failedCall(c.name, c.args, { ...c.metadata, recovered: true })} index={0} total={1} />);
      expect(recovered.container.textContent).not.toContain(verb);
      expect(recovered.container.querySelector('[data-testid="tool-call-recovered-note"]')).not.toBeNull();
      cleanup();
      const plain = render(<ToolCallDisplay toolCall={failedCall(c.name, c.args, c.metadata)} index={0} total={1} />);
      expect(plain.container.textContent).toContain(verb);
      expect(plain.container.querySelector('[data-testid="tool-call-recovered-note"]')).toBeNull();
    });

    it.each(NEVER_EXECUTED)('$label keeps the never-executed verb even when recovered', (c) => {
      mocks.language = locale;
      const view = render(<ToolCallDisplay toolCall={failedCall(c.name, c.args, { ...c.metadata, recovered: true })} index={0} total={1} />);
      expect(view.container.textContent).toContain(c.verbs[idx]);
    });

    it.each(CASES)('$kind through projectTurns → ToolStepGroup (single and multi step)', (c) => {
      mocks.language = locale;
      const verb = c.verbs[idx];
      const retryResult = { toolCallId: 'retry', success: true, output: 'ok' };
      const build = (withRetry: boolean): Message[] => [
        { id: 'u', role: 'user', content: 'go', timestamp: 1 },
        { id: 'a', role: 'assistant', content: '', timestamp: 2, toolCalls: [
          failedCall(c.name, c.args, c.metadata),
          ...(withRetry ? [{ id: 'retry', name: c.name, arguments: c.args, result: retryResult } as ToolCall] : []),
        ] },
      ];
      const nodesOf = (msgs: Message[]) => projectTurns(msgs, 's', false, []).turns.flatMap((t) => t.nodes).filter((n) => n.toolCall);
      const recoveredNodes = nodesOf(build(true));
      const failedNode = recoveredNodes.find((n) => n.toolCall?.id === 'failed')!;
      const shouldRecover = c.kind === 'edit';
      expect(Boolean(failedNode.toolCall?.recovered)).toBe(shouldRecover);
      if (!shouldRecover) return;
      const single = render(<ToolStepGroup nodes={[failedNode]} defaultExpanded={false} />);
      expect(single.container.textContent).not.toContain(verb);
      cleanup();
      const multi = render(<ToolStepGroup nodes={recoveredNodes} defaultExpanded={false} />);
      expect(multi.container.textContent).not.toContain(verb);
      cleanup();
      const unrecovered = render(<ToolStepGroup nodes={nodesOf(build(false))} defaultExpanded={false} />);
      expect(unrecovered.container.textContent).toContain(verb);
    });
  });
}
