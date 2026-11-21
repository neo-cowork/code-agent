// ============================================================================
// CronJobList —— 自动化中心左侧任务列表。
// 副标题说人话：cron 表达式经 utils/cronHumanize 翻成「每天 08:30 / 工作日 15:00」，
// 覆盖不了的形态回退原表达式；底部右侧触发源 chip（定时/一次性/循环/心跳/事件）
// 语义对齐 contract 的 SessionAutomationType，由 getCronTriggerKind 推导。
// ============================================================================

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';
import {
  filterVisibleCronJobs,
  useCronStore,
  type CronLocationFilter,
} from '../../../stores/cronStore';
import { useI18n } from '../../../hooks/useI18n';
import { getCronTriggerKind } from '../../../utils/cronHumanize';
import {
  formatScheduleSummary,
  getLatestExecutionStatus,
} from './types';
import { formatCronJobDateTime, formatCronScheduleLabelWithZone } from '../../../utils/formatCronJobTime';
import { CronJobWorkingFolderStatus } from './CronWorkingFolderStatus';
import { CronRunsOnPill } from './CronRunsOnSelector';
import { useEventScheduleNames } from './useChannelCatalog';
import type { CronJobDefinition } from '@shared/contract';
import { getJobDisplayName, getBuiltinJobDisplay, isBuiltinMaintenanceJob, getRoleWakeJobDescription } from './builtinJobDisplay';

interface CronJobListProps {
  /** jobId → 等批准运行（N-CRON-UNATTENDED-BASH-PARK-STUCK）：命中行的状态 chip 换成「等你确认」。 */
  awaitingByJobId?: Map<string, unknown>;
}

interface CronJobRowProps {
  job: CronJobDefinition;
  isSelected: boolean;
  awaitingApproval: boolean;
}

const CronJobRow: React.FC<CronJobRowProps> = ({ job, isSelected, awaitingApproval }) => {
  const { t, language } = useI18n();
  const cc = t.cronCenter;
  const selectJob = useCronStore((state) => state.selectJob);
  const latest = useCronStore((state) => state.latestExecutions[job.id]);
  // event 行的账号/群显示名（通道目录）；目录没有的回落 id（formatScheduleSummary 兜底）。
  const eventNamesFor = useEventScheduleNames();
  const latestMeta = getLatestExecutionStatus(latest, cc, t.cronWakeCadence);
  const latestLabel = latestMeta.label;
  const triggerKind = getCronTriggerKind(job);
  const builtinDisplay = getBuiltinJobDisplay(job, language);
  const displayName = getJobDisplayName(job, language);
  const displayDescription = builtinDisplay?.description ?? getRoleWakeJobDescription(job, language) ?? job.description;
  const scheduleSummary = job.schedule.type === 'cron'
    ? formatCronScheduleLabelWithZone(job.schedule.expression, job.schedule.timezone, language)
    : formatScheduleSummary(job, language, eventNamesFor(job));
  return (
    <button /* ds-allow:button: 任务列表行（多行内容左对齐布局），primitive 是居中动作按钮形状不适配 */
      onClick={() => selectJob(job.id)}
      className={`w-full rounded-xl border p-3 text-left transition-colors ${
        isSelected
          ? 'border-badge-info/40 bg-blue-500/10'
          : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-sm font-medium text-zinc-100">{displayName}</div>
            <CronRunsOnPill runsOn={job.runsOn} localLabel={cc.locationLocal} cloudLabel={cc.locationCloud} />
          </div>
          <div className="mt-1 text-xs text-zinc-500" data-testid="cron-job-schedule-summary">
            {scheduleSummary}
          </div>
          {job.enabled && job.nextRunAt != null && (
            <div className="mt-0.5 text-xs text-zinc-500" data-testid="cron-job-next-run">
              {cc.nextRun.replace('{time}', formatCronJobDateTime(
                job.nextRunAt,
                job.schedule.type === 'cron' ? job.schedule.timezone : undefined,
                language,
              ))}
            </div>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${
            job.enabled ? 'bg-emerald-500/10 text-badge-success' : 'bg-zinc-500/10 text-zinc-300'
          }`}
        >
          {job.enabled ? cc.enabled : cc.disabled}
        </span>
      </div>

      <CronJobWorkingFolderStatus job={job} />

      {displayDescription && (
        <div className="mt-2 line-clamp-2 text-xs text-zinc-400">{displayDescription}</div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 text-xs">
        {awaitingApproval ? (
          <span
            className="rounded-full border border-badge-warning/40 bg-amber-500/15 px-2 py-1 text-badge-warning"
            data-testid="cron-job-awaiting-approval"
          >
            {cc.awaitingApprovalBadge}
          </span>
        ) : (
          <span className={`rounded-full px-2 py-1 ${latestMeta.className}`}>
            {cc.latest.replace('{label}', latestLabel)}
          </span>
        )}
        {/* 触发源 chip：信息性标识统一中性 zinc，彩色只留给「要你处理的地方」 */}
        <span
          className="shrink-0 whitespace-nowrap rounded-full border border-zinc-700/70 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-400"
          data-testid="cron-job-trigger-kind"
        >
          {cc.triggerKind[triggerKind]}
        </span>
      </div>
    </button>
  );
};

export const CronJobList: React.FC<CronJobListProps> = ({ awaitingByJobId }) => {
  const { t, language } = useI18n();
  const cc = t.cronCenter;
  const {
    jobs,
    selectedJobId,
    filterMode,
    locationFilter,
    searchQuery,
    isLoading,
    setFilterMode,
    setLocationFilter,
    setSearchQuery,
    openCreateEditor,
    refresh,
  } = useCronStore();
  const [builtinOpen, setBuiltinOpen] = useState(false);

  const filteredJobs = useMemo(
    () => filterVisibleCronJobs(jobs, searchQuery, locationFilter, language),
    [jobs, searchQuery, locationFilter, language],
  );
  const userJobs = useMemo(() => filteredJobs.filter((job) => !isBuiltinMaintenanceJob(job)), [filteredJobs]);
  const builtinJobs = useMemo(() => filteredJobs.filter(isBuiltinMaintenanceJob), [filteredJobs]);
  const userJobCount = useMemo(() => jobs.filter((job) => !isBuiltinMaintenanceJob(job)).length, [jobs]);
  const effectiveSelectedJobId = useMemo(
    () => (selectedJobId && filteredJobs.some((job) => job.id === selectedJobId)
      ? selectedJobId
      : userJobs[0]?.id ?? null),
    [filteredJobs, userJobs, selectedJobId],
  );
  const builtinExpanded = builtinOpen || searchQuery.trim() !== '';

  return (
    <div className="flex h-full flex-col border-r border-zinc-800 bg-zinc-950/80 contain-size">
      <div className="border-b border-zinc-800 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-zinc-100">{cc.listTitle}</h3>
            <p className="mt-1 text-xs text-zinc-500">{cc.listSubtitle}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button /* ds-allow:button: 面板头图标按钮 p-1.5，primitive 变体会渲染可见底色改变尺寸 */
              onClick={() => refresh()}
              disabled={isLoading}
              title={cc.refresh}
              className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button /* ds-allow:button: 描边超小尺寸按钮（py-1.5 text-xs），primitive 最小 sm 仍更大 */
              onClick={openCreateEditor}
              className="shrink-0 whitespace-nowrap inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <Plus className="h-3.5 w-3.5" />
              {cc.create}
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={cc.searchPlaceholder}
          />
          <div className="flex rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5" role="group" aria-label={cc.executionLocationTitle}>
            {([
              ['all', cc.locationFilterAll],
              ['local', cc.locationLocal],
              ['cloud', cc.locationCloud],
            ] as Array<[CronLocationFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setLocationFilter(value)}
                className={`flex-1 rounded-md px-2 py-1 text-xs transition-colors ${locationFilter === value
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'}`}
                data-testid={`cron-location-filter-${value}`}
              >
                {label}
              </button>
            ))}
          </div>
          <Select
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as typeof filterMode)}
            options={[
              { value: 'all', label: cc.filterAll },
              { value: 'enabled', label: cc.filterEnabled },
              { value: 'disabled', label: cc.filterDisabled },
            ]}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {userJobs.length === 0 && builtinJobs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-500">
            {jobs.length === 0 ? cc.emptyNone : cc.emptyNoMatch}
          </div>
        ) : (
          <div className="space-y-2">
            {userJobs.length === 0 && (
              <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-500">
                {userJobCount === 0 ? cc.emptyNone : cc.emptyNoMatch}
              </div>
            )}
            {userJobs.map((job) => (
              <CronJobRow
                key={job.id}
                job={job}
                isSelected={job.id === effectiveSelectedJobId}
                awaitingApproval={awaitingByJobId?.has(job.id) ?? false}
              />
            ))}
            {builtinJobs.length > 0 && (
              <div data-testid="cron-builtin-group" className="pt-1">
                <button /* ds-allow:button: 分组折叠头（左对齐文本行），primitive 是居中动作按钮形状不适配 */
                  type="button"
                  onClick={() => setBuiltinOpen((open) => !open)}
                  aria-expanded={builtinExpanded}
                  data-testid="cron-builtin-group-toggle"
                  className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-300"
                >
                  {builtinExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {cc.builtinGroupTitle.replace('{count}', String(builtinJobs.length))}
                </button>
                {builtinExpanded && (
                  <div className="mt-2 space-y-2">
                    {builtinJobs.map((job) => (
                      <CronJobRow
                        key={job.id}
                        job={job}
                        isSelected={job.id === effectiveSelectedJobId}
                        awaitingApproval={awaitingByJobId?.has(job.id) ?? false}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default CronJobList;
