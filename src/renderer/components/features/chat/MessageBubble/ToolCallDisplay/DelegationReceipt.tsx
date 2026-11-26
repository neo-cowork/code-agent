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
import { useDelegationRetry } from '../../../../../hooks/useDelegationRetry';
import { DeleteIncompleteActions } from '../../../background/DeleteIncompleteActions';
import { GuiTakeoverDisclosureRows } from '../../../GuiTakeoverDisclosureRows';
import type { DelegationPresentation } from './delegationPresentation';
import { interpolatePlural } from '../../../../../i18n/interpolate';

const HEADLINE_SENTENCE_END = /[。.!！?？]+$/u;

/** 状态后缀非空时，去掉标题句末标点，避免句号和状态词贴在分隔符两侧。不改 presentation.title。 */
function headlineDisplayTitle(title: string, suffix: string): string {
  return suffix ? title.replace(HEADLINE_SENTENCE_END, '') : title;
}

export function DelegationHeader({ presentation }: { presentation: DelegationPresentation }) {
  const { t } = useI18n();
  const template = presentation.outcomeKey
    ? t.outcomeWords[presentation.outcomeKey].assistant.label
    : t.chat.delegationReceipt.headlines[presentation.state];
  const [prefix, suffix = ''] = template.split('{name}');
  const shownTitle = headlineDisplayTitle(presentation.title, suffix);
  const headline = `${prefix}${shownTitle}${suffix}`;
  return (
    <div className="min-w-0 flex-1 truncate font-sans text-xs text-zinc-200" title={headline} data-testid="delegation-headline">
      {prefix && <span className="text-zinc-500">{prefix}</span>}
      <span className="font-semibold" title={shownTitle}>{shownTitle}</span>
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

export function DelegationReceipt({ presentation, superseded = false }: { presentation: DelegationPresentation; superseded?: boolean }) {
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

  const guiDisclosures = <GuiTakeoverDisclosureRows disclosures={presentation.guiDisclosures} />;

  if (superseded && presentation.state === 'failed') {
    return (
      <div className="ml-6 mt-0.5 text-xs text-zinc-500" data-testid="delegation-failure-superseded">
        {guiDisclosures}
        {t.delegationFailedActions.superseded}
      </div>
    );
  }

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
        {guiDisclosures}
        {describeLastToolStep(presentation.lastToolStep, t, status)}
      </div>
    );
  }

  return (
    <div className="ml-6 mt-0.5 space-y-0.5 text-xs text-zinc-500" data-testid="delegation-receipt">
      {guiDisclosures}
      {presentation.stepCount !== undefined && (
        <div>{interpolatePlural(t.chat.delegationReceipt.steps, presentation.stepCount)}</div>
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
      {(presentation.state === 'failed' || presentation.state === 'cancelled') && (
        <DelegationRetryActions presentation={presentation} />
      )}
    </div>
  );
}

/** 失败或取消回执的两个出口：看成员详情（同成员条 chip 的视图）、一键把重做句作为普通用户消息发出。 */
function DelegationRetryActions({ presentation }: { presentation: DelegationPresentation }) {
  const { t } = useI18n();
  const text = t.delegationFailedActions;
  const { memberId } = presentation;
  const cancelled = presentation.state === 'cancelled';
  const task = (presentation.retryTitle ?? (cancelled ? '' : presentation.title)).trim();
  const retryIdentity = memberId ?? presentation.activityIds[0] ?? task;
  const retryPrefix = retryIdentity ? `delegation-retry-${retryIdentity}-` : '';
  const retry = useDelegationRetry(presentation.sessionId, retryPrefix, presentation.endedAt);
  const draft = cancelled ? text.cancelledRetryDraft : text.retryDraft;
  const incomplete = presentation.state === 'failed' && presentation.outcomeKey === 'delete-incomplete';
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
      {incomplete ? (
        <DeleteIncompleteActions
          key={`${retryIdentity}-${presentation.endedAt}`}
          attemptId={retryIdentity}
          sessionId={presentation.sessionId}
          endedAt={presentation.endedAt}
          leftoverPaths={presentation.leftoverPaths}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          data-testid="delegation-retry"
          disabled={retry.disabled || !task}
          title={retry.showBusyHint || !task ? text.retryBusy : undefined}
          onClick={() => { void retry.send(draft.replace('{task}', task)); }}
        >
          {text.retry}
        </Button>
      )}
    </div>
  );
}
