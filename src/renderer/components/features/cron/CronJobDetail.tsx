// ============================================================================
// CronJobDetail —— 自动化中心右侧任务详情。
// 头部两行摘要（调度+下次运行 / 状态+动作）取代早期四磁贴；重试/超时等工程参数
// 收在「高级参数」折叠区；无描述时显示引导文案（入口样式，不接功能）。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import type { CronJobDefinition } from '@shared/contract';
import type { AwaitingApprovalRun } from '@shared/contract/sessionAutomation';
import { Activity, ChevronRight, Copy, LockKeyhole, Pencil, Play, Power, Sparkles, Trash2 } from 'lucide-react';
import { useCronStore } from '../../../stores/cronStore';
import { useI18n } from '../../../hooks/useI18n';
import {
  formatActionSummary,
  formatScheduleSummary,
  getLatestExecutionStatus,
} from './types';
import { formatDateTime } from '../../../utils/formatDateTime';
import {
  cronJobUsesDifferentTimeZone,
  formatCronJobDateTime,
  formatCronJobLocalDateTime,
  formatCronScheduleLabelWithZone,
} from '../../../utils/formatCronJobTime';
import { CronExecutionList } from './CronExecutionList';
import { CronExecutionDetail } from './CronExecutionDetail';
import { CLOUD_ROLE_BOUND_ERROR } from './CronCloudRoleRestriction';
import { CronRunsOnPill } from './CronRunsOnSelector';
import { CronResultChannelSummary } from './CronResultChannel';
import { useEventScheduleNames } from './useChannelCatalog';
import { CronGroupListenCheck } from './CronGroupListenCheck';
import { CronWebhookLinkBlock } from './CronWebhookLinkBlock';
import { CronEventDecisionsPanel } from './CronEventDecisionsPanel';
import { CronJobApprovalHint } from './CronJobApprovalHint';
import { getBuiltinJobDisplay } from './builtinJobDisplay';
import { isWebhookCronJob } from '@shared/cronWebhookJob';
import { CronWriteScopePanel } from './CronWriteScopePanel';

interface CronJobDetailProps {
  job: CronJobDefinition | null;
  /** 等批准运行（N-CRON-UNATTENDED-BASH-PARK-STUCK）：头 chip 换 amber 徽章 + 一句提示 + 去处理。 */
  awaitingRun?: AwaitingApprovalRun | null;
  onReviewAwaiting?: () => void;
  onApprovalResolved?: () => Promise<void>;
}

export const CronJobDetail: React.FC<CronJobDetailProps> = ({ job, awaitingRun = null, onReviewAwaiting, onApprovalResolved }) => {
  const { t, language } = useI18n();
  const cc = t.cronCenter;
  const {
    executionsByJobId,
    latestExecutions,
    loadExecutions,
    openEditEditor,
    openCopyEditor,
    updateJob,
    deleteJob,
    triggerJob,
  } = useCronStore();
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  // event 摘要的账号/群显示名（通道目录）；目录没有的回落 id。挂在早退 return 之前（hook 不得条件调用）。
  const eventNamesFor = useEventScheduleNames();

  useEffect(() => {
    if (!job) return;
    loadExecutions(job.id);
  }, [job, loadExecutions]);

  useEffect(() => {
    if (!job) {
      setSelectedExecutionId(null);
      return;
    }
    const executions = executionsByJobId[job.id] || [];
    setSelectedExecutionId((current) =>
      current && executions.some((execution) => execution.id === current)
        ? current
        : executions[0]?.id || null
    );
  }, [job, executionsByJobId]);

  const executions = job ? executionsByJobId[job.id] || [] : [];
  const selectedExecution = useMemo(
    () => executions.find((execution) => execution.id === selectedExecutionId) || null,
    [executions, selectedExecutionId]
  );

  if (!job) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-900/40">
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-8 text-center">
          <div className="text-sm text-zinc-300">{cc.detailEmptyTitle}</div>
          <div className="mt-2 text-xs text-zinc-500">{cc.detailEmptySub}</div>
        </div>
      </div>
    );
  }

  const latest = latestExecutions[job.id];
  const latestMeta = getLatestExecutionStatus(latest, cc);
  const latestLabel = latestMeta.label;
  const awaitingApproval = awaitingRun != null;
  const builtinDisplay = getBuiltinJobDisplay(job, language);
  const displayName = builtinDisplay?.name ?? job.name;
  const displayDescription = builtinDisplay?.description ?? job.description;
  const cronTimeZone = job.schedule.type === 'cron' ? job.schedule.timezone : undefined;
  const scheduleSummary = job.schedule.type === 'cron'
    ? formatCronScheduleLabelWithZone(job.schedule.expression, job.schedule.timezone, language)
    : formatScheduleSummary(job, language, eventNamesFor(job));

  const handleToggleEnabled = async () => {
    setToggleError(null);
    try {
      await updateJob(job.id, { enabled: !job.enabled });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      setToggleError(message.includes(CLOUD_ROLE_BOUND_ERROR) ? cc.cloudRoleBoundHint : message || cc.simpleCreateFailed);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(cc.confirmDelete.replace('{name}', displayName))) return;
    await deleteJob(job.id);
  };

  const handleTrigger = async () => {
    setIsTriggering(true);
    try {
      await triggerJob(job.id);
    } finally {
      setIsTriggering(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-zinc-900/40 contain-size">
      <div className="border-b border-zinc-800 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-zinc-100">{displayName}</h3>
              {awaitingApproval ? (
                <span
                  className="rounded-full border border-badge-warning/40 bg-amber-500/15 px-2 py-1 text-xs text-badge-warning"
                  data-testid="cron-detail-awaiting-approval"
                >
                  {cc.awaitingApprovalBadge}
                </span>
              ) : (
                <span className={`rounded-full px-2 py-1 text-xs ${latestMeta.className}`}>
                  {cc.latest.replace('{label}', latestLabel)}
                </span>
              )}
            </div>
            {awaitingRun && (
              <CronJobApprovalHint
                key={awaitingRun.requestId}
                run={awaitingRun}
                onReview={onReviewAwaiting}
                onResolved={onApprovalResolved}
              />
            )}
            <div className="mt-2 max-w-3xl text-sm">
              {displayDescription ? (
                <p className="text-zinc-400">{displayDescription}</p>
              ) : (
                // 引导文案 + 入口样式（不接功能）：虚线描边 = 可补全的占位，不是报错
                <span
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-zinc-700 px-2.5 py-1 text-xs text-zinc-500"
                  data-testid="cron-detail-description-guide"
                >
                  <Sparkles className="h-3 w-3" />
                  {cc.descriptionGuide}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <button /* ds-allow:button: 详情头部超小文本按钮组（py-1.5 text-xs），primitive 最小 sm 仍更大 */
              onClick={() => openEditEditor(job.id)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <Pencil className="h-3.5 w-3.5" />
              {cc.edit}
            </button>
            <button /* ds-allow:button: 同上，超小文本按钮组 */
              onClick={handleToggleEnabled}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <Power className="h-3.5 w-3.5" />
              {job.enabled ? cc.disable : cc.enable}
            </button>
            <button /* ds-allow:button: 同上，超小文本按钮组（蓝色语义） */
              onClick={handleTrigger}
              disabled={isTriggering}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-badge-info transition-colors hover:bg-blue-500/10 hover:text-badge-info disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              {isTriggering ? cc.triggering : cc.trigger}
            </button>
            <button /* ds-allow:button: 同上，超小文本按钮组（红色语义） */
              onClick={handleDelete}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-badge-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {cc.delete}
            </button>
          </div>
        </div>
        {toggleError && (
          <div role="alert" data-testid="cron-detail-toggle-error" className="mt-2 text-xs text-badge-danger">
            {toggleError}
          </div>
        )}

        {/* 四磁贴 → 两行摘要：调度+下次运行讲「什么时候跑」，状态+动作讲「跑什么」，
            同一件事不再拆成四张卡各说一遍 */}
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-1.5">
            <SummaryItem label={cc.cardSchedule} value={scheduleSummary} />
            <SummaryItem
              label={cc.cardNextRun}
              value={job.enabled && job.nextRunAt != null
                ? formatCronJobDateTime(job.nextRunAt, cronTimeZone, language)
                : '—'}
              testId="cron-detail-next-run"
            />
            {job.enabled && job.nextRunAt != null && cronJobUsesDifferentTimeZone(cronTimeZone) && (
              <div className="basis-full text-xs text-zinc-500" data-testid="cron-detail-local-next-run">
                {cc.localNextRun.replace('{time}', formatCronJobLocalDateTime(job.nextRunAt, language))}
              </div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-8 gap-y-1.5 border-t border-zinc-800/70 pt-2">
            <SummaryItem label={cc.cardEnabledState} value={job.enabled ? cc.enabled : cc.disabled} />
            <SummaryItem label={cc.cardAction} value={formatActionSummary(job, language)} testId="cron-detail-action" />
            <CronResultChannelSummary value={job.resultChannel} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800/70 pt-2">
            <span className="text-xs text-zinc-500">{cc.cardExecutionLocation}</span>
            <CronRunsOnPill runsOn={job.runsOn} localLabel={cc.locationLocal} cloudLabel={cc.locationCloud} />
            <LockKeyhole className="h-3.5 w-3.5 text-zinc-500" />
            <span className="text-xs text-zinc-500">{cc.locationCreatedImmutable}</span>
            <button
              type="button"
              onClick={() => openCopyEditor(job.id)}
              className="ml-auto inline-flex items-center gap-1 text-xs text-badge-info hover:text-badge-info"
              data-testid="cron-copy-by-location"
            >
              <Copy className="h-3.5 w-3.5" />
              {cc.copyByLocation}
            </button>
          </div>
        </div>

        {job.enabled && job.runsOn === 'local' && job.schedule.type === 'event'
          && job.schedule.source === 'channel' && job.schedule.chatId && (
          <CronGroupListenCheck key={`${job.id}:${job.updatedAt}`} jobId={job.id} />
        )}

        {isWebhookCronJob(job) && <CronWebhookLinkBlock key={`${job.id}:${job.enabled}`} job={job} />}

        {job.schedule.type === 'event' && <CronEventDecisionsPanel job={job} />}

        {/* 写授权面板：只有本地 agent 任务有「agent 写文件」这回事（shell 动作走 Bash、
            云端任务不在本机写），其余动作面不渲染。 */}
        {job.runsOn === 'local' && job.action.type === 'agent' && (
          <CronWriteScopePanel job={job} />
        )}

        <details className="mt-4 group" data-testid="cron-detail-advanced">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            {cc.advancedSection}
          </summary>
          <div className="mt-3 grid gap-3 lg:grid-cols-5">
            <InfoCard label={cc.cardCreatedAt} value={formatDateTime(job.createdAt, language)} />
            <InfoCard label={cc.cardUpdatedAt} value={formatDateTime(job.updatedAt, language)} />
            <InfoCard label={cc.cardMaxRetries} value={job.maxRetries != null ? String(job.maxRetries) : '0'} />
            <InfoCard label={cc.cardRetryDelay} value={job.retryDelay != null ? `${job.retryDelay}ms` : '—'} />
            <InfoCard label={cc.cardTimeout} value={job.timeout != null ? `${job.timeout}ms` : '—'} />
          </div>
        </details>

        {job.tags && job.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {job.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300"
              >
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-[200px] p-5">
        <div className="mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4 text-badge-info" />
          <h4 className="text-sm font-medium text-zinc-100">{cc.historyTitle}</h4>
        </div>
        {executions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-8 text-center text-sm text-zinc-500">
            {cc.historyEmpty}
          </div>
        ) : (
          <div className="grid min-h-0 gap-4 xl:grid-cols-[1.4fr_1fr]">
            <section className="min-h-0 overflow-y-auto">
              <CronExecutionList
                executions={executions}
                runsOnByJobId={{ [job.id]: job.runsOn }}
                selectedExecutionId={selectedExecutionId}
                onSelectExecution={setSelectedExecutionId}
              />
            </section>
            <section className="min-h-0 overflow-y-auto">
              <CronExecutionDetail execution={selectedExecution} jobName={job.name} runsOn={job.runsOn} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
};

const InfoCard: React.FC<{ label: string; value: string; testId?: string }> = ({ label, value, testId }) => (
  <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3" data-testid={testId}>
    <div className="text-xs text-zinc-500">{label}</div>
    <div className="mt-1 text-sm text-zinc-200">{value}</div>
  </div>
);

// 摘要行内项：标签小字 + 值同行，值可截断（动作摘要可能是一整段 prompt）
const SummaryItem: React.FC<{ label: string; value: string; testId?: string }> = ({ label, value, testId }) => (
  <div className="flex min-w-0 items-baseline gap-2 text-sm" data-testid={testId}>
    <span className="shrink-0 text-xs text-zinc-500">{label}</span>
    <span className="truncate text-zinc-200">{value}</span>
  </div>
);

export default CronJobDetail;
