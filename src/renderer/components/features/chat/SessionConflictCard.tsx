// ============================================================================
// SessionConflictCard - 「会话被旧任务占着」失败说明下的「放弃 / 重试」两个按钮
// ============================================================================
// 宿主对 409 RUN_SESSION_CONFLICT 的人话说明（httpFailureMessage）点名了两个按钮，
// 这张卡让它们真实存在：放弃 → 走既有取消链路（agent:cancel + abandonParked，
// 终态化停靠的旧 run）；重试 → 走既有失败重发路径（messageActionStore.regenerateMessage，
// 原 clientMessageId 原样重发），并像 ProjectTrustConfirmCard 一样摘掉这条旧说明，
// 再被拒时新的说明替换它，时间线上始终只有一条可重试说明。
// ============================================================================

import React, { useCallback, useState } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { useMessageActionStore } from '../../../stores/messageActionStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { clearFailedSend } from '../../../stores/failedSendOutbox';
import ipcService from '../../../services/ipcService';
import type { TraceNode } from '@shared/contract/trace';

type AbandonState = 'idle' | 'abandoning' | 'done' | 'failed';

export function SessionConflictCard({ node, sessionId }: {
  node: TraceNode;
  sessionId?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const copy = t.turnCard.sessionConflict;
  const [state, setState] = useState<AbandonState>('idle');
  const messageId = node.messageId || (node.id.endsWith('-text') ? node.id.slice(0, -5) : node.id);
  const anchorSessionId = typeof node.metadata?.retrySessionId === 'string'
    ? node.metadata.retrySessionId
    : sessionId;
  const retryClientMessageId = typeof node.metadata?.retryClientMessageId === 'string'
    ? node.metadata.retryClientMessageId
    : undefined;

  const onAbandon = useCallback(async () => {
    if (!anchorSessionId) return;
    setState('abandoning');
    try {
      // web 取消路由对「没找到可终态化的 run」也回 200（message 不是 Cancelled，旧任务仍在）：
      // 租约还没回收的窗口里真机撞到过——不能把它报成「已结束」。桌面 IPC 无返回体，按成功算。
      const result = await ipcService.invoke(IPC_CHANNELS.AGENT_CANCEL, { sessionId: anchorSessionId, abandonParked: true }) as unknown;
      const message = (result as { message?: unknown } | null | undefined)?.message;
      if (typeof message === 'string' && message !== 'Cancelled') throw new Error('nothing cancelled');
      // 与「放弃」停靠入口一致：不乐观清「可继续」投影，防陈旧快照守卫把它复活。
      useSessionStore.setState((s) => ({
        sessions: s.sessions.map((session) => (
          session.id === anchorSessionId && session.durableResume
            ? { ...session, durableResume: undefined }
            : session
        )),
      }));
      void useSessionStore.getState().loadSessions({ silent: true });
      setState('done');
    } catch {
      setState('failed');
    }
  }, [anchorSessionId]);

  const onRetry = useCallback(() => {
    useMessageActionStore.getState().regenerateMessage(messageId);
    // 旧说明到此过时：从时间线和失败发件箱摘掉，再被拒时由新说明替换。
    const sessions = useSessionStore.getState();
    if (anchorSessionId && retryClientMessageId) clearFailedSend(anchorSessionId, retryClientMessageId);
    if (!anchorSessionId || sessions.currentSessionId === anchorSessionId) {
      sessions.setMessages(sessions.messages.filter((message) => message.id !== messageId));
    }
  }, [anchorSessionId, messageId, retryClientMessageId]);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="session-conflict-actions">
      <Button
        size="sm"
        variant="secondary"
        loading={state === 'abandoning'}
        disabled={state === 'done'}
        onClick={() => void onAbandon()}
      >
        {copy.abandon}
      </Button>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {copy.retry}
      </Button>
      {state === 'done' && <span className="text-[13px] text-text-secondary" role="status">{copy.abandoned}</span>}
      {state === 'failed' && <span className="text-[13px] text-text-secondary" role="status">{copy.abandonFailed}</span>}
    </div>
  );
}
