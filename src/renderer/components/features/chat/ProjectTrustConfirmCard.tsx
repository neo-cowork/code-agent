// ============================================================================
// ProjectTrustConfirmCard - 发送失败气泡上的「确认并重发」入口
// ============================================================================
// 旧项目 Source 身份快照缺失时发送被 422 PROJECT_SOURCE_TRUST 拒（人话句子已在
// 失败气泡正文里，由 agentRunErrors 给）。这张卡只做恢复动作：点按钮 → 调宿主
// /api/project/confirm-source-trust（只带 sessionId，路径/Source 集合全由服务端
// 现读）→ 成功后走既有失败重发路径（messageActionStore.regenerateMessage，复用
// 原 clientMessageId 原样重发）；确认失败保留原因说明，目录缺失或变更时打开既有项目设置重新选择。
// ============================================================================

import React, { useCallback, useRef, useState } from 'react';
import { ProjectSettingsDialog } from '../../ProjectSettingsDialog';
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
  const presetMissing = node.metadata?.sendFailureKind === 'source_missing';
  const presetFolder = typeof node.metadata?.sendFailureFolderName === 'string'
    ? node.metadata.sendFailureFolderName
    : undefined;
  const [state, setState] = useState<ConfirmState>(presetMissing ? 'failed' : 'idle');
  const [failure, setFailure] = useState<{ reason?: string; folderName?: string } | undefined>(
    presetMissing ? { reason: 'source_missing', folderName: presetFolder } : undefined,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const confirming = useRef(false);
  const messageId = node.messageId || (node.id.endsWith('-text') ? node.id.slice(0, -5) : node.id);
  // 锚点绑了失败时的会话就用它——跨会话重发等于把内容发进别的会话。
  const anchorSessionId = typeof node.metadata?.retrySessionId === 'string'
    ? node.metadata.retrySessionId
    : sessionId;
  const retryClientMessageId = typeof node.metadata?.retryClientMessageId === 'string'
    ? node.metadata.retryClientMessageId
    : undefined;

  const projectId = useSessionStore((store) => store.sessions.find((session) => session.id === anchorSessionId)?.projectId);
  const copy = t.turnCard.projectTrustConfirm;
  const reason = failure?.reason;
  const failureText = reason && Object.hasOwn(copy.reasons, reason)
    ? copy.reasons[reason as keyof typeof copy.reasons].replace('{name}', failure?.folderName || copy.folder)
    : copy.failed;
  const canReselect = Boolean(projectId) && (reason === 'source_missing' || reason === 'identity_changed');

  const onConfirm = useCallback(async () => {
    if (confirming.current) return;
    confirming.current = true;
    setState('confirming');
    try {
      const confirmed = await ipcService.unsafeInvoke<{ confirmed?: boolean; reason?: string; folderName?: string }>(
        'project:confirm-source-trust',
        { sessionId: anchorSessionId },
      );
      if (!confirmed?.confirmed) {
        setFailure(confirmed ?? {});
        setState('failed');
        return;
      }
      if (anchorSessionId && useSessionStore.getState().currentSessionId !== anchorSessionId) {
        setState('failed');
        return;
      }
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
      setFailure({});
      setState('failed');
    } finally {
      confirming.current = false;
    }
  }, [anchorSessionId, messageId, retryClientMessageId]);

  if (state === 'sent') return null;
  // 气泡已经写了「找不到文件夹」这句。首屏只留重新选择，不再把同一句画第二遍，也不给确认按钮。
  const missingFolderAction = presetMissing
    && failure?.reason === 'source_missing'
    && (state === 'failed' || state === 'confirming');
  return (
    <div className="mt-2" data-testid="project-trust-confirm">
      {missingFolderAction ? (
        <Button
          size="sm"
          variant="secondary"
          loading={state === 'confirming'}
          onClick={() => setSettingsOpen(true)}
        >
          {copy.reselect}
        </Button>
      ) : state === 'failed' ? (
        <div className="flex flex-col items-start gap-2">
          <span className="text-[13px] text-text-secondary">{failureText}</span>
          {canReselect && (
            <Button size="sm" variant="secondary" onClick={() => setSettingsOpen(true)}>
              {copy.reselect}
            </Button>
          )}
        </div>
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
      {settingsOpen && projectId && (
        <ProjectSettingsDialog
          projectId={projectId}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSaved={(detail) => {
            setSettingsOpen(false);
            if (detail) void onConfirm();
          }}
        />
      )}
    </div>
  );
}
