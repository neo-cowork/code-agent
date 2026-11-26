// ============================================================================
// SessionConflictCard - 「会话被旧任务占着」失败说明下的唯一「重试」按钮
// ============================================================================
// 宿主对 409 RUN_SESSION_CONFLICT 的人话说明（httpFailureMessage）只点名「重试」：
// 一次点击 = 先结束停靠的旧 run（agent:cancel + abandonParked，重启后租约回收前会回
// "No active agent to cancel"，每 3 秒重复一次，最长约 25 秒，直到回 "Cancelled"），
// 再走既有失败重发路径（messageActionStore.regenerateMessage，原 clientMessageId 原样重发）
// 且只重发一次；等满 25 秒仍没放行也照样重发一次，再被拒时新说明替换它（始终只有一条可重试说明）。
// 取消调用抛错则结束等待并给出失败说明；卡片卸载则停止循环。
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { useMessageActionStore } from '../../../stores/messageActionStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { clearFailedSend } from '../../../stores/failedSendOutbox';
import ipcService from '../../../services/ipcService';
import type { TraceNode } from '@shared/contract/trace';

type RetryState = 'idle' | 'waiting' | 'failed';

const CANCEL_POLL_INTERVAL_MS = 3000;
// 0、3、…、24 秒各取消一次：旧行租约回收窗口约 15–20 秒，留余量，总等待 < 30 秒。
const CANCEL_MAX_ATTEMPTS = 9;
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export function SessionConflictCard({ node, sessionId }: {
  node: TraceNode;
  sessionId?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const copy = t.turnCard.sessionConflict;
  const [state, setState] = useState<RetryState>('idle');
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const messageId = node.messageId || (node.id.endsWith('-text') ? node.id.slice(0, -5) : node.id);
  const anchorSessionId = typeof node.metadata?.retrySessionId === 'string'
    ? node.metadata.retrySessionId
    : sessionId;
  const retryClientMessageId = typeof node.metadata?.retryClientMessageId === 'string'
    ? node.metadata.retryClientMessageId
    : undefined;

  const resend = useCallback(() => {
    const resent = useMessageActionStore.getState().regenerateMessage(messageId);
    if (!resent) {
      if (mountedRef.current) setState('idle');
      return;
    }
    // 旧说明到此过时：从时间线和失败发件箱摘掉，再被拒时由新说明替换。
    const sessions = useSessionStore.getState();
    if (anchorSessionId && retryClientMessageId) clearFailedSend(anchorSessionId, retryClientMessageId);
    if (!anchorSessionId || sessions.currentSessionId === anchorSessionId) {
      sessions.setMessages(sessions.messages.filter((message) => message.id !== messageId));
    }
  }, [anchorSessionId, messageId, retryClientMessageId]);

  const onRetry = useCallback(async () => {
    if (!anchorSessionId) { resend(); return; }
    setState('waiting');
    try {
      for (let attempt = 0; attempt < CANCEL_MAX_ATTEMPTS; attempt += 1) {
        // web 取消路由对「没找到可终态化的 run」也回 200（message 不是 Cancelled，旧任务仍在）：
        // 租约还没回收的窗口里真机撞到过。桌面 IPC 无返回体，按成功算。
        const result = await ipcService.invoke(IPC_CHANNELS.AGENT_CANCEL, { sessionId: anchorSessionId, abandonParked: true }) as unknown;
        if (!mountedRef.current) return;
        const message = (result as { message?: unknown } | null | undefined)?.message;
        if (typeof message !== 'string' || message === 'Cancelled') break;
        if (attempt < CANCEL_MAX_ATTEMPTS - 1) {
          await sleep(CANCEL_POLL_INTERVAL_MS);
          if (!mountedRef.current) return;
        }
      }
    } catch {
      if (mountedRef.current) setState('failed');
      return;
    }
    // 不乐观清「可继续」投影，防陈旧快照守卫把它复活；只刷新会话列表。
    useSessionStore.setState((s) => ({
      sessions: s.sessions.map((session) => (
        session.id === anchorSessionId && session.durableResume
          ? { ...session, durableResume: undefined }
          : session
      )),
    }));
    void useSessionStore.getState().loadSessions({ silent: true });
    resend();
  }, [anchorSessionId, resend]);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="session-conflict-actions">
      <Button size="sm" variant="secondary" loading={state === 'waiting'} onClick={() => void onRetry()}>
        {copy.retry}
      </Button>
      {state === 'failed' && <span className="text-[13px] text-text-secondary" role="status">{copy.abandonFailed}</span>}
    </div>
  );
}
