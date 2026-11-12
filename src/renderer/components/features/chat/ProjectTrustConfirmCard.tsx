// ============================================================================
// ProjectTrustConfirmCard - 发送失败气泡上的「确认并重发」入口
// ============================================================================
// 旧项目 Source 身份快照缺失时发送被 422 PROJECT_SOURCE_TRUST 拒（人话句子已在
// 失败气泡正文里，由 agentRunErrors 给）。这张卡只做恢复动作：点按钮 → 调宿主
// /api/project/confirm-source-trust（只带 sessionId，路径/Source 集合全由服务端
// 现读）→ 成功后走既有失败重发路径（messageActionStore.regenerateMessage，复用
// 原 clientMessageId 原样重发）；确认失败则换一句通用失败句，不透传任何内部码。
// ============================================================================

import React, { useCallback, useState } from 'react';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { useMessageActionStore } from '../../../stores/messageActionStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { clearFailedSend } from '../../../stores/failedSendOutbox';
import ipcService from '../../../services/ipcService';
import type { TraceNode } from '@shared/contract/trace';

type ConfirmState = 'idle' | 'confirming' | 'sent' | 'failed';

export function ProjectTrustConfirmCard({ node, sessionId }: {
  node: TraceNode;
  sessionId?: string;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [state, setState] = useState<ConfirmState>('idle');
  const messageId = node.messageId || (node.id.endsWith('-text') ? node.id.slice(0, -5) : node.id);
  // 锚点绑了失败时的会话就用它——跨会话重发等于把内容发进别的会话。
  const anchorSessionId = typeof node.metadata?.retrySessionId === 'string'
    ? node.metadata.retrySessionId
    : sessionId;
  const retryClientMessageId = typeof node.metadata?.retryClientMessageId === 'string'
    ? node.metadata.retryClientMessageId
    : undefined;

  const onConfirm = useCallback(async () => {
    setState('confirming');
    try {
      const confirmed = await ipcService.unsafeInvoke<{ confirmed?: boolean }>(
        'project:confirm-source-trust',
        { sessionId: anchorSessionId },
      );
      if (!confirmed?.confirmed) throw new Error('confirm unavailable');
      // 确认成功：复用既有失败重发路径，原 clientMessageId 原样重发
      useMessageActionStore.getState().regenerateMessage(messageId);
      // 这句「需要你确认」到此已经过时：从时间线和失败发件箱里拿掉，
      // 否则它会一直挂在新回复上面（真跑实测），读起来像确认没生效。
      const sessions = useSessionStore.getState();
      if (anchorSessionId && retryClientMessageId) clearFailedSend(anchorSessionId, retryClientMessageId);
      if (!anchorSessionId || sessions.currentSessionId === anchorSessionId) {
        sessions.setMessages(sessions.messages.filter((message) => message.id !== messageId));
      }
      setState('sent');
    } catch {
      setState('failed');
    }
  }, [anchorSessionId, messageId, retryClientMessageId]);

  if (state === 'sent') return null;
  return (
    <div className="mt-2" data-testid="project-trust-confirm">
      {state === 'failed' ? (
        <span className="text-[13px] text-text-secondary">{t.turnCard.projectTrustConfirm.failed}</span>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          loading={state === 'confirming'}
          onClick={() => void onConfirm()}
        >
          {t.turnCard.projectTrustConfirm.button}
        </Button>
      )}
    </div>
  );
}
