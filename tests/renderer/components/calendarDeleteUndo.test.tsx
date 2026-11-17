// @vitest-environment jsdom
// 删一条日程后结果里的「撤销」：只传会话 + 工具调用 id，宿主用自存快照重建（N-CALENDAR-ONE-PERMISSION-EVENTKIT 真机第三轮）。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/services/ipcService', () => ({ invokeDomain: invoke, default: {} }));
import { CalendarDeleteUndo, canUndoCalendarDelete } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/CalendarDeleteUndo';

const deleted = (metadata: Record<string, unknown>, success = true): ToolCall => ({
  id: 'tc-del', name: 'calendar_delete_event', arguments: { calendar: '日历', event_uid: 'cal:EV1' },
  result: { toolCallId: 'tc-del', success, metadata },
} as ToolCall);

beforeEach(() => invoke.mockReset());
afterEach(cleanup);

it('shows Undo only for a successful delete with a host snapshot, and undoes by ids only', async () => {
  expect(canUndoCalendarDelete(deleted({ undoable: true }))).toBe(true);
  expect(canUndoCalendarDelete(deleted({ undoable: false }))).toBe(false);
  expect(canUndoCalendarDelete(deleted({ undoable: true }, false))).toBe(false);
  expect(canUndoCalendarDelete({ ...deleted({ undoable: true }), name: 'calendar_update_event' })).toBe(false);

  invoke.mockResolvedValue({ ok: true, uid: 'cal:EV2' });
  render(<CalendarDeleteUndo toolCall={deleted({ undoable: true, before: { title: '评审' } })} sessionId="s" />);
  fireEvent.click(screen.getByTestId('calendar-delete-undo'));
  await waitFor(() => expect(screen.getByTestId('calendar-delete-undone').textContent).toBe('已撤销，日程已恢复'));
  expect(invoke).toHaveBeenCalledExactlyOnceWith('domain:connector', 'undoCalendarDelete', { sessionId: 's', toolCallId: 'tc-del' });
});

it('an already undone delete reads as undone after reload; a failed restore says so and keeps the button', async () => {
  render(<CalendarDeleteUndo toolCall={deleted({ undoable: true, undoneUid: 'cal:EV2' })} sessionId="s" />);
  expect(screen.getByTestId('calendar-delete-undone')).toBeTruthy();
  cleanup();
  invoke.mockResolvedValue({ ok: false, reason: 'restore_failed' });
  render(<CalendarDeleteUndo toolCall={deleted({ undoable: true })} sessionId="s" />);
  fireEvent.click(screen.getByTestId('calendar-delete-undo'));
  await waitFor(() => expect(screen.getByTestId('calendar-delete-undo-failed').textContent).toBe('没能恢复这条日程'));
  expect(screen.getByTestId('calendar-delete-undo')).toBeTruthy();
});
