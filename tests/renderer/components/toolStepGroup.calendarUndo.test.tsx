// @vitest-environment jsdom
// 真机第四轮：删一条日程后结果里找不到「撤销」——它原来挂在步骤展开后的子行里，而步骤组默认收起。
// 撤销要挂在组这一层，不展开也看得到。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const SESSION = 'session_undo';

function deleteNode(metadata: Record<string, unknown>): TraceNode {
  return {
    id: 'node-del', type: 'tool_call', content: '', timestamp: 1,
    toolCall: {
      id: 'call_del', name: 'calendar_delete_event', args: { calendar: '日历', event_uid: 'cal:EV1' },
      success: true, result: '已删除日历事件：\n- [日历] F 复验', metadata,
    },
  } as unknown as TraceNode;
}

beforeEach(() => {
  useAppStore.setState({ language: 'zh', processingSessionIds: new Set(), isProcessing: false });
  useSessionStore.setState({ currentSessionId: SESSION, sessions: [{ id: SESSION, title: 't', createdAt: 1, updatedAt: 1, status: 'idle' }] as never });
});
afterEach(() => {
  cleanup();
  useSessionStore.setState({ currentSessionId: null, sessions: [] });
});

it('a collapsed delete step still shows Undo; a delete without a snapshot does not', () => {
  const view = render(<ToolStepGroup nodes={[deleteNode({ action: 'delete_event', undoable: true, before: { title: 'F 复验' } })]} sessionId={SESSION} />);
  expect(screen.getByTestId('calendar-delete-undo').textContent).toBe('撤销');
  view.unmount();
  render(<ToolStepGroup nodes={[deleteNode({ action: 'delete_event', undoable: false })]} sessionId={SESSION} />);
  expect(screen.queryByTestId('calendar-delete-undo')).toBeNull();
});
