// ============================================================================
// CronDailyCostSummary —— 运行成本每日小计（N-CRON-RUN-LEDGER-VISIBLE）。
// 数据口径在 shared/cronRunLedger.cronDailyCostTotals（本地日历日、云端不计入、
// 无成本/跳过条目计数不加钱）；这里只做呈现，自动化中心与角色页共用。
// ============================================================================
import React from 'react';
import type { CronJobExecution } from '@shared/contract';
import { cronDailyCostTotals, cronTodayYesterdayKeys, readWakeSkipFromResult } from '@shared/cronRunLedger';
import { useI18n } from '../../../hooks/useI18n';
import { formatRunCostUsd } from './types';

interface CronDailyCostSummaryProps {
  /** 参与小计的执行记录（范围由调用方定：全任务 or 单角色的 role-wake 任务）。 */
  executions: CronJobExecution[];
  testId?: string;
}

function hasUnrecordedSessionCost(execution: CronJobExecution): boolean {
  if (execution.cost != null || readWakeSkipFromResult(execution.result) !== null) return false;
  if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(execution.status)) return false;
  // A missing cost alone is normal for non-model actions and wakes resolved before
  // creating a session. Only a finished session can have an unrecorded model cost.
  const result = execution.result;
  const sessionId = execution.sessionId ?? (
    typeof result === 'object' && result !== null && 'sessionId' in result ? result.sessionId : undefined
  );
  return typeof sessionId === 'string' && sessionId.length > 0;
}

export const CronDailyCostSummary: React.FC<CronDailyCostSummaryProps> = ({
  executions,
  testId = 'cron-daily-cost-summary',
}) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const totals = cronDailyCostTotals(executions.map((execution) => ({
    scheduledAt: execution.scheduledAt,
    startedAt: execution.startedAt,
    cost: execution.cost,
    runsOn: execution.runsOn,
    skipped: readWakeSkipFromResult(execution.result) !== null,
  })));
  const incompleteDays = new Set(cronDailyCostTotals(executions
    .filter(hasUnrecordedSessionCost)
    .map((execution) => ({ scheduledAt: execution.scheduledAt, startedAt: execution.startedAt, runsOn: execution.runsOn })))
    .map((bucket) => bucket.dayKey));
  if (totals.length === 0) return null;
  const { today, yesterday } = cronTodayYesterdayKeys(Date.now());
  return (
    <div
      data-testid={testId}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs"
    >
      <span className="text-zinc-500">{cc.dailyCostTitle}</span>
      {totals.map((bucket) => {
        const label = bucket.dayKey === today
          ? cc.dailyCostToday
          : bucket.dayKey === yesterday ? cc.dailyCostYesterday : bucket.dayKey.slice(5);
        const runsNote = bucket.skippedCount > 0
          ? cc.dailyCostSkippedSuffix.replace('{count}', String(bucket.skippedCount))
          : cc.dailyCostRunsSuffix.replace('{count}', String(bucket.runCount));
        return (
          <span key={bucket.dayKey} data-testid={`${testId}-day`} className="text-zinc-400">
            {label}{' '}
            <span className="font-medium tabular-nums text-zinc-200">{incompleteDays.has(bucket.dayKey) ? cc.dailyCostIncomplete : formatRunCostUsd(bucket.totalUsd)}</span>
            <span className="text-zinc-600">{runsNote}</span>
          </span>
        );
      })}
    </div>
  );
};
