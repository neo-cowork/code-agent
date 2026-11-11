import React from 'react';
import { useI18n } from '../../../../../hooks/useI18n';
import { useAppStore } from '../../../../../stores/appStore';
import { describeLastToolFailure, describeLastToolStep, resolveAgentActivityStepStatus } from '../../../../../utils/agentActivity';
import { agentFailureCopy } from '../../../../../utils/agentFailureCopy';
import { openExternalLink } from '../../../../../utils/platform';
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

export function DelegationReceipt({ presentation }: { presentation: DelegationPresentation }) {
  const { t } = useI18n();
  const openPreview = useAppStore((state) => state.openPreview);
  // 审批未决时活动行不得谎报完成态（N-APPROVAL-PENDING-STATUS-COPY）：连接器写
  // 步在审批卡挂着时亮「请求…」词形，卡一答完、工具在跑就落「正在…」词形。
  const pendingPermissionRequest = useAppStore((state) => state.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore((state) => state.pendingPermissionSessionId);
  const queuedPermissionRequests = useAppStore((state) => state.queuedPermissionRequests);
  const failure = presentation.state === 'failed'
    ? agentFailureCopy(presentation.failureCode, t, presentation.failure)
    : presentation.failure;
  const toolFailure = presentation.state === 'working'
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
    </div>
  );
}
