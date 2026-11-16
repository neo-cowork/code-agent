// 删一条日程后的「撤销」：宿主按会话 + 工具调用 id 用删除前快照重建（N-CALENDAR-ONE-PERMISSION-EVENTKIT）。
// 渲染层只传 id，不传日程内容。
import React, { useState } from 'react';
import type { ToolCall } from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import { Button } from '../../../../primitives';
import { useI18n } from '../../../../../hooks/useI18n';
import { invokeDomain } from '../../../../../services/ipcService';

type State = 'idle' | 'busy' | 'done' | 'failed';

/** 只有删除成功、宿主留了快照的那一步才显示 */
export function canUndoCalendarDelete(toolCall: ToolCall): boolean {
  return toolCall.name === 'calendar_delete_event'
    && toolCall.result?.success === true
    && toolCall.result.metadata?.undoable === true;
}

export function CalendarDeleteUndo({ toolCall, sessionId }: { toolCall: ToolCall; sessionId?: string }): React.ReactElement | null {
  const { t } = useI18n();
  const w = t.decisionCard.permission.writeback;
  const alreadyUndone = typeof toolCall.result?.metadata?.undoneUid === 'string';
  const [state, setState] = useState<State>(alreadyUndone ? 'done' : 'idle');
  if (!sessionId) return null;
  const undo = async () => {
    setState('busy');
    try {
      const result = await invokeDomain<{ ok: boolean; reason?: string }>(IPC_DOMAINS.CONNECTOR, 'undoCalendarDelete', { sessionId, toolCallId: toolCall.id });
      setState(result?.ok || result?.reason === 'already_undone' ? 'done' : 'failed');
    } catch {
      setState('failed');
    }
  };
  if (state === 'done') return <p className="ml-6 mt-1 text-xs text-badge-success" data-testid="calendar-delete-undone">{w.undoDeleteDone}</p>;
  return (
    <div className="ml-6 mt-1 flex items-center gap-2">
      <Button type="button" variant="secondary" size="sm" disabled={state === 'busy'} onClick={() => void undo()} data-testid="calendar-delete-undo">
        {state === 'busy' ? w.undoDeleteBusy : w.undoDelete}
      </Button>
      {state === 'failed' && <span className="text-xs text-zinc-400" data-testid="calendar-delete-undo-failed">{w.undoDeleteFailed}</span>}
    </div>
  );
}
