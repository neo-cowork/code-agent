import React from 'react';
import { useI18n } from '../../../../../hooks/useI18n';
import { useAppStore } from '../../../../../stores/appStore';
import { useSessionStore } from '../../../../../stores/sessionStore';
import { useSessionListLoadStore } from '../../../../../stores/sessionListPagination';
import { Button } from '../../../../primitives/Button';
import { describeLastToolFailure, describeLastToolStep, resolveAgentActivityStepStatus } from '../../../../../utils/agentActivity';
import { agentFailureCopy } from '../../../../../utils/agentFailureCopy';
import { openExternalLink } from '../../../../../utils/platform';
import { useMemberViewStore } from '../../../../../stores/memberViewStore';
import { neoUIActionRouter } from '../../../../../services/neoUIActionRouter';
import type { DelegationPresentation } from './delegationPresentation';

export function DelegationHeader({ presentation }: { presentation: DelegationPresentation }) {
  const { t } = useI18n();
  const template = t.chat.delegationReceipt.headlines[presentation.state];
  const [prefix, suffix] = template.split('{name}');
  const headline = template.replace('{name}', presentation.title);
  return (
    <div className="min-w-0 flex-1 truncate text-xs text-zinc-200" title={headline} data-testid="delegation-headline">
      {prefix && <span className="text-zinc-500">{prefix}</span>}
      <span className="font-semibold" title={presentation.title}>{presentation.title}</span>
      {suffix && <span className="text-zinc-500">{suffix}</span>}
    </div>
  );
}

/** 目标会话还在才给入口；列表已读完（无更早分页）却找不到它 = 已删除/归档。 */
function useTargetSessionAvailable(targetSessionId: string | undefined): boolean {
  const listed = useSessionStore((state) => Boolean(targetSessionId) && state.sessions.some((session) => session.id === targetSessionId));
  const hasOlder = useSessionStore((state) => state.hasOlderSessions);
  const settled = useSessionListLoadStore((state) => state.settled);
  return Boolean(targetSessionId) && (listed || hasOlder || !settled);
}

export function DelegationReceipt({ presentation }: { presentation: DelegationPresentation }) {
  const { t } = useI18n();
  const openPreview = useAppStore((state) => state.openPreview);
  // 审批未决时活动行不得谎报完成态（N-APPROVAL-PENDING-STATUS-COPY）：连接器写
  // 步在审批卡挂着时亮「请求…」词形，卡一答完、工具在跑就落「正在…」词形。
  const pendingPermissionRequest = useAppStore((state) => state.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore((state) => state.pendingPermissionSessionId);
  const queuedPermissionRequests = useAppStore((state) => state.queuedPermissionRequests);
  const targetAvailable = useTargetSessionAvailable(presentation.targetSessionId);
  const failure = presentation.state === 'failed'
    ? agentFailureCopy(presentation.failureCode, t, presentation.failure)
    : presentation.failure;
  const toolFailure = presentation.state === 'working' || presentation.state === 'cancelled'
    ? undefined
    : describeLastToolFailure(presentation.toolFailure, t);

  if (presentation.state === 'working') {
    const status = resolveAgentActivityStepStatus({
      step: presentation.lastToolStep,
      working: true,
      activityIds: presentation.activityIds,
      sessionId: presentation.sessionId ?? null,
      permission: { pendingPermissionRequest, pendingPermissionSessionId, queuedPermissionRequests },
    });
    return (
      <div className="ml-6 mt-0.5 truncate text-xs text-zinc-500" data-testid="delegation-activity">
        {describeLastToolStep(presentation.lastToolStep, t, status)}
      </div>
    );
  }

  return (
    <div className="ml-6 mt-0.5 space-y-0.5 text-xs text-zinc-500" data-testid="delegation-receipt">
      {presentation.stepCount !== undefined && (
        <div>{t.chat.delegationReceipt.steps.replace('{count}', String(presentation.stepCount))}</div>
      )}
      {presentation.outputs.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span>{t.chat.delegationReceipt.output}</span>
          {presentation.outputs.map((output) => (
            <button
              key={output.id}
              type="button"
              className="max-w-[240px] truncate rounded bg-white/[0.04] px-1.5 py-0.5 text-zinc-300 hover:bg-white/[0.08] hover:text-zinc-100"
              title={output.target}
              onClick={() => {
                if (output.kind === 'file') openPreview(output.target);
                else openExternalLink(output.target);
              }}
            >
              {output.label}
            </button>
          ))}
        </div>
      )}
      {targetAvailable && presentation.targetSessionId && (
        <Button
          variant="ghost"
          size="sm"
          data-testid="delegation-view-target"
          onClick={() => { void useSessionStore.getState().switchSession(presentation.targetSessionId as string); }}
        >
          {t.chat.delegationReceipt.viewTargetSession}
        </Button>
      )}
      {presentation.branch && (
        <div data-testid="delegation-branch">
          {t.chat.delegationReceipt.mergeBranch.replace('{branch}', presentation.branch)}
        </div>
      )}
      {failure && (
        <div className="line-clamp-2 break-words text-badge-danger" data-testid="delegation-failure">
          {failure}
        </div>
      )}
      {toolFailure && (
        <div className="break-words" data-testid="delegation-tool-failure">
          <span className="text-badge-danger">{toolFailure.summary}</span>
          {toolFailure.detail && <span className="text-zinc-400"> · {toolFailure.detail}</span>}
        </div>
      )}
      {presentation.state === 'failed' && <DelegationFailedActions presentation={presentation} />}
    </div>
  );
}

/** 失败回执的两个出口：看成员详情（同成员条 chip 的视图）、把重做句放进输入框（不自动发送）。 */
function DelegationFailedActions({ presentation }: { presentation: DelegationPresentation }) {
  const { t } = useI18n();
  const text = t.delegationFailedActions;
  const { memberId } = presentation;
  return (
    <div className="flex items-center gap-1.5" data-testid="delegation-failed-actions">
      {memberId && (
        <Button
          variant="ghost"
          size="sm"
          data-testid="delegation-view-details"
          onClick={() => useMemberViewStore.getState().setViewingMemberId(memberId)}
        >
          {text.viewDetails}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        data-testid="delegation-retry"
        onClick={() => neoUIActionRouter.fillComposer(text.retryDraft.replace('{task}', presentation.retryTitle ?? presentation.title))}
      >
        {text.retry}
      </Button>
    </div>
  );
}
