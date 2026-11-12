// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import type { ToolCall } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en', tree: vi.fn() }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: mocks.language === 'zh' ? zh : en }) }));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({ useAgentTreeSnapshot: (...args: unknown[]) => { mocks.tree(...args); return { snapshot: null }; } }));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({ useBackgroundTaskStore: (select: (s: unknown) => unknown) => select({ tasks: [] }) }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({ useSessionStore: (select: (s: unknown) => unknown) => select({ currentSessionId: 'session' }) }));
vi.mock('../../../src/renderer/stores/appStore', () => {
  const useAppStore = (select: (s: unknown) => unknown) => select({ processingSessionIds: new Set(), queuedPermissionRequests: {}, pendingPermissionRequest: null });
  return { useAppStore: Object.assign(useAppStore, { getState: () => useAppStore((s) => s) }) };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const secret = 'delegation_private-fixture';
function tool(payload: Record<string, unknown>, action = 'delegate_existing'): ToolCall {
  return { id: 'call', name: 'delegate_session', arguments: { action, candidateSetId: secret, candidateRef: secret, text: secret }, result: {
    toolCallId: 'call', success: true, output: JSON.stringify({ delegationId: secret, target: 'Q3 报告', status: 'active', queuedAhead: 0, ...payload }),
  } };
}
for (const locale of ['zh', 'en'] as const) {
  describe(`rendered delegation receipt (${locale})`, () => {
    it.each([
      [{}, 'delegate_existing', '已把任务交给「Q3 报告」', 'Sent the task to “Q3 报告”'],
      [{ reused: true }, 'delegate_existing', '已送达过，未重复发送 · 「Q3 报告」', 'Already delivered; not sent again · “Q3 报告”'],
      [{}, 'create_new', '已新建对话「Q3 报告」并交给它', 'Created conversation “Q3 报告” and sent it the task'],
      [{ target: null }, 'delegate_existing', '已把任务交给另一个对话', 'Sent the task to another conversation'],
    ] as const)('shows the receipt card %j / %s', (payload, action, chinese, english) => {
      mocks.language = locale;
      const view = render(<ToolCallDisplay toolCall={tool(payload, action)} index={0} total={1} />);
      const expected = locale === 'zh' ? chinese : english;
      expect(view.getByText(expected)).toBeTruthy();
      expect(view.getByTestId('delegation-receipt')).toBeTruthy();
      expect(view.container.textContent).not.toMatch(/delegation_private-fixture|active|reused|candidateSetId|delegate_session/);
      expect(mocks.tree).toHaveBeenCalledWith('session', false);
    });
    it('routes a single trace receipt through the delegation card', () => {
      mocks.language = locale;
      const tc = tool({ reused: true });
      const node: TraceNode = { id: tc.id, messageId: 'message', type: 'tool_call', content: '', timestamp: 1,
        toolCall: { id: tc.id, name: tc.name, args: tc.arguments, result: tc.result!.output, success: true } };
      const view = render(<ToolStepGroup nodes={[node]} sessionId="session" />);
      expect(view.getByTestId('delegation-receipt')).toBeTruthy();
      expect(view.container.textContent).toContain(locale === 'zh' ? '已送达过，未重复发送 · 「Q3 报告」' : 'Already delivered; not sent again · “Q3 报告”');
      expect(view.container.textContent).not.toMatch(/delegation_private-fixture|active|reused|candidateSetId|delegate_session/);
    });
    it('renders candidate lookup without raw output references', () => {
      mocks.language = locale;
      const tc: ToolCall = { ...tool({}), name: 'list_session_candidates' };
      tc.result!.output = JSON.stringify({ candidateSetId: secret, candidates: [{ candidateRef: secret }] });
      const view = render(<ToolCallDisplay toolCall={tc} index={0} total={1} />);
      expect(view.getByText(locale === 'zh' ? '已查找可委托的对话' : 'Found conversations for delegation')).toBeTruthy();
      expect(view.container.textContent).not.toMatch(/delegation_private-fixture|active|reused|candidateSetId|delegate_session/);
    });
    it('keeps a rejection out of the success card and its code out of the title', () => {
      mocks.language = locale;
      const tc = tool({}); tc.result!.success = false; tc.result!.error = 'invalid_call: Nothing was delegated';
      const view = render(<ToolCallDisplay toolCall={tc} index={0} total={1} />);
      expect(view.queryByTestId('delegation-receipt')).toBeNull();
      const title = view.getByTestId('tool-call-row-delegate_session').textContent;
      expect(title).not.toMatch(/invalid_call|code:/);
    });
  });
}
