import React, { useEffect, useState } from 'react';
import type { CronJobExecution } from '@shared/contract';
import type { RoleWakeFunnel, RoleWakeLedgerBasisCounts, RoleWakeLedgerRecentRow } from '@shared/contract/roleAssets';
import { ROLE_PROACTIVITY } from '@shared/constants';
import { interpolate, interpolatePlural } from '../../../i18n/interpolate';
import { getRoleWakeFunnel, getRoleWakeLedgerRecent } from '../../../services/rolesClient';
import { useI18n } from '../../../hooks/useI18n';
import { cronClient } from '../../../services/cronClient';
import { SettingsSection } from '../settings/SettingsLayout';
import { CronDailyCostSummary } from '../cron/CronDailyCostSummary';
import { wakeSkipSentence } from '../cron/wakeSkipSentence';
import { formatRunCostUsd } from '../cron/types';
import { formatDateTime } from '../../../utils/formatDateTime';

const WAKE_HISTORY_PER_JOB = ROLE_PROACTIVITY.WAKE_LEDGER_RECENT_ROWS;
const REASON_CODES = [
  'no_products',
  'excluded_topic',
  'previously_reported',
  'missing_decision',
  'work_advanced',
  'change_reported',
  'action_suggested',
  'no_action_needed',
] as const;

type ReasonCode = (typeof REASON_CODES)[number];

interface MergedWakeRow {
  key: string;
  at: number;
  execution?: CronJobExecution;
  ledger?: RoleWakeLedgerRecentRow;
}

function isReasonCode(reason: string): reason is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(reason);
}

function hideRawBasis(reason: string): string {
  return reason.replace(/(?:^|\s)(?:mail|calendar):[^\s,，。；;]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function loadRoleWakeExecutions(roleId: string): Promise<CronJobExecution[]> {
  const jobs = await cronClient.listJobs();
  const wakeJobIds = jobs
    .filter((job) => job.action.type === 'role-wake' && job.action.roleId === roleId)
    .map((job) => job.id);
  const lists = await Promise.all(wakeJobIds.map((jobId) => cronClient.getExecutions(jobId, WAKE_HISTORY_PER_JOB)));
  return lists.flat().sort((a, b) => (b.startedAt ?? b.scheduledAt) - (a.startedAt ?? a.scheduledAt));
}

function mergeWakeRows(executions: CronJobExecution[], ledger: RoleWakeLedgerRecentRow[]): MergedWakeRow[] {
  const orderedLedger = ledger.map((row, index) => ({ row, index }));
  const used = new Set<number>();
  const matched = new Map<string, RoleWakeLedgerRecentRow>();
  const executionsByStart = [...executions].sort(
    (a, b) => (a.startedAt ?? a.scheduledAt) - (b.startedAt ?? b.scheduledAt),
  );
  for (const execution of executionsByStart) {
    const start = execution.startedAt ?? execution.scheduledAt;
    let best: { index: number; distance: number } | null = null;
    for (const item of orderedLedger) {
      if (used.has(item.index)) continue;
      const distance = item.row.at - start;
      if (distance < 0 || distance > ROLE_PROACTIVITY.WAKE_LEDGER_EXECUTION_MATCH_MS) continue;
      if (!best || distance < best.distance) best = { index: item.index, distance };
    }
    if (!best) continue;
    used.add(best.index);
    const found = orderedLedger.find((item) => item.index === best?.index);
    if (found) matched.set(execution.id, found.row);
  }
  const rows: MergedWakeRow[] = executions.map((execution) => ({
    key: `exec:${execution.id}`,
    at: execution.startedAt ?? execution.scheduledAt,
    execution,
    ledger: matched.get(execution.id),
  }));
  for (const item of orderedLedger) {
    if (used.has(item.index)) continue;
    rows.push({ key: `ledger:${item.row.at}:${item.index}`, at: item.row.at, ledger: item.row });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, ROLE_PROACTIVITY.WAKE_LEDGER_RECENT_ROWS);
}

export const RoleWakeLedger: React.FC<{ roleId: string; refreshToken?: number }> = ({ roleId, refreshToken = 0 }) => {
  const { t, language } = useI18n();
  const cc = t.cronCenter;
  const roleCopy = t.expert.roleDetail;
  const [executions, setExecutions] = useState<CronJobExecution[] | null>(null);
  const [ledger, setLedger] = useState<RoleWakeLedgerRecentRow[] | null>(null);
  const [funnel, setFunnel] = useState<RoleWakeFunnel | 'unavailable' | null>(null);
  const loadedRoleIdRef = React.useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // 只有换角色才清空重挂；refreshToken 刷新（「现在运行」结束）保留旧列表重拉，不闪空态
    if (loadedRoleIdRef.current !== roleId) {
      loadedRoleIdRef.current = roleId;
      setExecutions(null);
      setLedger(null);
      setFunnel(null);
    }
    void loadRoleWakeExecutions(roleId)
      .then((list) => { if (!cancelled) setExecutions(list); })
      .catch(() => { if (!cancelled) setExecutions([]); });
    void getRoleWakeLedgerRecent(roleId)
      .then((rows) => { if (!cancelled) setLedger(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setLedger([]); });
    void getRoleWakeFunnel(roleId)
      .then((counts) => {
        if (!cancelled) setFunnel(Array.isArray(counts?.duplicates) ? counts : 'unavailable');
      })
      .catch(() => { if (!cancelled) setFunnel('unavailable'); });
    return () => { cancelled = true; };
  }, [roleId, refreshToken]);
  if (executions === null || ledger === null) return null;
  const rows = mergeWakeRows(executions, ledger);
  const reasonSentence = (row: RoleWakeLedgerRecentRow): string => {
    if (row.reason === 'previously_reported' && row.firstReportedAt != null) {
      return interpolate(roleCopy.roleWakePreviouslyReported, {
        time: formatDateTime(row.firstReportedAt, language),
      });
    }
    if (isReasonCode(row.reason)) return roleCopy.roleWakeReason[row.reason];
    return hideRawBasis(row.reason) || roleCopy.roleWakeReason.missing_decision;
  };
  const newBasisSentence = (counts: RoleWakeLedgerBasisCounts): string => {
    const items = [
      counts.mail > 0 ? interpolatePlural(roleCopy.roleWakeNewMail, counts.mail) : '',
      counts.calendar > 0 ? interpolatePlural(roleCopy.roleWakeNewCalendar, counts.calendar) : '',
    ].filter(Boolean);
    if (items.length === 0) return '';
    return interpolate(roleCopy.roleWakeNewBasis, { items: items.join(roleCopy.roleWakeNewBasisSeparator) });
  };
  const decisionSentence = (row: RoleWakeLedgerRecentRow): string => [
    roleCopy.roleWakeDecision[row.decision],
    reasonSentence(row),
    newBasisSentence(row.newBasis),
  ].filter(Boolean).join(' · ');
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
      {rows.length === 0 ? (
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
          {rows.map((row) => {
            const skipText = row.execution ? wakeSkipSentence(row.execution, {
              silentLevel: cc.wakeSkipSilentLevel,
              dailyBudget: cc.wakeSkipDailyBudget,
              quietHours: cc.wakeSkipQuietHours,
              connectorLost: t.cronWakeCadence.connectorLost,
              nameLanguage: language,
              generic: t.cronWakeCadence.skipGeneric,
            }) : null;
            const costText = !row.execution || skipText
              ? null
              : row.execution.cost != null
                ? formatRunCostUsd(row.execution.cost)
                : row.execution.flatFee
                  ? cc.costFlatFee
                  : cc.roleWakeNoModel;
            const value = [row.ledger ? decisionSentence(row.ledger) : '', skipText, costText].filter(Boolean).join(' · ');
            return (
              <li
                key={row.key}
                data-testid="role-wake-ledger-row"
                className="flex items-start justify-between gap-3 text-xs text-zinc-400"
              >
                <span className="shrink-0">{formatDateTime(row.at, language)}</span>
                <span className="min-w-0 text-right" data-testid="role-wake-ledger-value">
                  {value}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsSection>
  );
};
