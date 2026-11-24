import React, { useEffect, useState } from 'react';
import type { CronJobExecution } from '@shared/contract';
import type { RoleWakeFunnel } from '@shared/contract/roleAssets';
import { interpolate } from '../../../i18n/interpolate';
import { getRoleWakeFunnel } from '../../../services/rolesClient';
import { useI18n } from '../../../hooks/useI18n';
import { cronClient } from '../../../services/cronClient';
import { SettingsSection } from '../settings/SettingsLayout';
import { CronDailyCostSummary } from '../cron/CronDailyCostSummary';
import { wakeSkipSentence } from '../cron/wakeSkipSentence';
import { formatRunCostUsd } from '../cron/types';
import { formatDateTime } from '../../../utils/formatDateTime';

const WAKE_HISTORY_PER_JOB = 20;

async function loadRoleWakeExecutions(roleId: string): Promise<CronJobExecution[]> {
  const jobs = await cronClient.listJobs();
  const wakeJobIds = jobs
    .filter((job) => job.action.type === 'role-wake' && job.action.roleId === roleId)
    .map((job) => job.id);
  const lists = await Promise.all(wakeJobIds.map((jobId) => cronClient.getExecutions(jobId, WAKE_HISTORY_PER_JOB)));
  return lists.flat().sort((a, b) => (b.startedAt ?? b.scheduledAt) - (a.startedAt ?? a.scheduledAt));
}

export const RoleWakeLedger: React.FC<{ roleId: string; refreshToken?: number }> = ({ roleId, refreshToken = 0 }) => {
  const { t, language } = useI18n();
  const cc = t.cronCenter;
  const roleCopy = t.expert.roleDetail;
  const [executions, setExecutions] = useState<CronJobExecution[] | null>(null);
  const [funnel, setFunnel] = useState<RoleWakeFunnel | 'unavailable' | null>(null);
  const loadedRoleIdRef = React.useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // 只有换角色才清空重挂；refreshToken 刷新（「现在运行」结束）保留旧列表重拉，不闪空态
    if (loadedRoleIdRef.current !== roleId) {
      loadedRoleIdRef.current = roleId;
      setExecutions(null);
      setFunnel(null);
    }
    void loadRoleWakeExecutions(roleId)
      .then((list) => { if (!cancelled) setExecutions(list); })
      .catch(() => { if (!cancelled) setExecutions([]); });
    void getRoleWakeFunnel(roleId)
      .then((counts) => {
        if (!cancelled) setFunnel(Array.isArray(counts?.duplicates) ? counts : 'unavailable');
      })
      .catch(() => { if (!cancelled) setFunnel('unavailable'); });
    return () => { cancelled = true; };
  }, [roleId, refreshToken]);
  if (executions === null) return null;
  return (
    <SettingsSection title={cc.roleWakeRecentTitle} description={cc.roleWakeRecentDescription}>
      {funnel === 'unavailable' && <p className="text-xs text-zinc-400">{roleCopy.roleWakeWeeklyUnavailable}</p>}
      {funnel && funnel !== 'unavailable' && (
        <div className="mb-3 space-y-1 text-xs text-zinc-400">
          <p data-testid="role-wake-weekly-funnel">{roleCopy.roleWakeWeeklyTitle} · {interpolate(roleCopy.roleWakeWeeklyCounts, {
            wakes: funnel.wakes, reports: funnel.reports, suppressed: funnel.suppressed,
          })}</p>
          {funnel.duplicates.length > 0 && (
            <ul className="space-y-1">
              {funnel.duplicates.map(({ at, firstReportedAt }, index) => (
                <li key={`${at}-${index}`}>{interpolate(roleCopy.roleWakeDuplicate, {
                  at: formatDateTime(at, language),
                  firstReportedAt: formatDateTime(firstReportedAt, language),
                })}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <CronDailyCostSummary executions={executions} testId="role-wake-daily-cost" />
      {executions.length === 0 ? (
        <div
          data-testid="role-wake-ledger-empty"
          className="rounded-lg border border-dashed border-zinc-700/70 p-4 text-center text-xs text-zinc-500"
        >
          {cc.roleWakeRecentEmpty}
        </div>
      ) : (
        <ul
          className="mt-2 space-y-1 rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3"
          data-testid="role-wake-ledger-list"
        >
          {executions.map((execution) => {
            const skipText = wakeSkipSentence(execution, {
              silentLevel: cc.wakeSkipSilentLevel,
              dailyBudget: cc.wakeSkipDailyBudget,
              quietHours: cc.wakeSkipQuietHours,
              generic: t.cronWakeCadence.skipGeneric,
            });
            return (
              <li
                key={execution.id}
                data-testid="role-wake-ledger-row"
                className="flex items-center justify-between gap-3 text-xs text-zinc-400"
              >
                <span>{formatDateTime(execution.startedAt ?? execution.scheduledAt, language)}</span>
                <span className="min-w-0 truncate text-right" data-testid="role-wake-ledger-value">
                  {skipText ?? (execution.cost != null ? formatRunCostUsd(execution.cost) : execution.flatFee ? cc.costFlatFee : cc.roleWakeNoModel)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsSection>
  );
};
