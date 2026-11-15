import { create } from 'zustand';
import type { CronEventActionMode } from '@shared/contract/cron';
import type {
  CronJobDefinition,
  CronJobExecution,
  CronRunsOn,
  CronServiceStats,
} from '@shared/contract';
import { isRoleBoundCronJob } from '@shared/cronRoleBinding';
import { isWebhookCronJob } from '@shared/cronWebhookJob';
import { getBuiltinJobDisplay } from '../components/features/cron/builtinJobDisplay';
import type { Language } from '../i18n';
import {
  cronClient,
  type CreateCronJobInput,
  type UpdateCronJobInput,
} from '../services/cronClient';
import { createLogger } from '../utils/logger';
import { useAppStore } from './appStore';

const logger = createLogger('CronStore');

export type CronJobFilterMode = 'all' | 'enabled' | 'disabled';
export type CronLocationFilter = 'all' | CronRunsOn;

export function filterVisibleCronJobs(
  jobs: readonly CronJobDefinition[],
  searchQuery: string,
  locationFilter: CronLocationFilter,
  language: Language,
): CronJobDefinition[] {
  const q = searchQuery.trim().toLowerCase();
  return jobs.filter((job) => {
    if (locationFilter !== 'all' && job.runsOn !== locationFilter) return false;
    if (!q) return true;
    const builtinDisplay = getBuiltinJobDisplay(job, language);
    const haystacks = [
      job.name,
      job.description || '',
      builtinDisplay?.name || '',
      builtinDisplay?.description || '',
      job.tags?.join(' ') || '',
    ];
    return haystacks.some((value) => value.toLowerCase().includes(q));
  });
}

function resolveSelectedCronJobId(
  visibleJobs: readonly CronJobDefinition[],
  selectedJobId: string | null,
): string | null {
  if (selectedJobId && visibleJobs.some((job) => job.id === selectedJobId)) {
    return selectedJobId;
  }
  return visibleJobs[0]?.id ?? null;
}

function currentLanguage(): Language {
  return useAppStore.getState().language;
}

interface CronState {
  jobs: CronJobDefinition[];
  /** Complete job catalog used for cross-job run labels; `jobs` may be filter-scoped. */
  allJobs: CronJobDefinition[];
  jobNamesLoaded: boolean;
  stats: CronServiceStats | null;
  latestExecutions: Record<string, CronJobExecution | null>;
  executionsByJobId: Record<string, CronJobExecution[]>;
  /** 跨任务执行流（运行记录 tab），按时间倒序 */
  recentExecutions: CronJobExecution[];
  selectedJobId: string | null;
  filterMode: CronJobFilterMode;
  locationFilter: CronLocationFilter;
  searchQuery: string;
  isLoading: boolean;
  isEditorOpen: boolean;
  editingJobId: string | null;
  copyingJobId: string | null;
  error: string | null;

  setFilterMode: (mode: CronJobFilterMode) => void;
  setLocationFilter: (filter: CronLocationFilter) => void;
  setSearchQuery: (query: string) => void;
  selectJob: (jobId: string | null) => void;
  openCreateEditor: () => void;
  openEditEditor: (jobId: string) => void;
  openCopyEditor: (jobId: string) => void;
  closeEditor: () => void;
  loadJobs: () => Promise<void>;
  loadStats: () => Promise<void>;
  loadExecutions: (jobId: string, limit?: number) => Promise<void>;
  loadRecentExecutions: (limit?: number) => Promise<void>;
  /** 有 running 执行时由面板轮询调用：一次请求同时校正「运行记录」流与各任务最近一次执行。 */
  syncRunningExecutions: () => Promise<void>;
  refresh: () => Promise<void>;
  createJob: (input: CreateCronJobInput) => Promise<CronJobDefinition>;
  updateJob: (jobId: string, updates: UpdateCronJobInput) => Promise<CronJobDefinition | null>;
  deleteJob: (jobId: string) => Promise<boolean>;
  triggerJob: (jobId: string) => Promise<CronJobExecution | null>;
  /** 事件自动化执行档切换（调用方负责先弹确认框）；成功后刷新任务表。 */
  setEventActionMode: (jobId: string, mode: CronEventActionMode) => Promise<CronJobDefinition | null>;
}

async function loadLatestExecution(jobId: string): Promise<CronJobExecution | null> {
  try {
    const executions = await cronClient.getExecutions(jobId, 1);
    return executions[0] || null;
  } catch (error) {
    logger.warn('Failed to load latest cron execution', { jobId, error });
    return null;
  }
}

export const useCronStore = create<CronState>()((set, get) => ({
  jobs: [],
  allJobs: [],
  jobNamesLoaded: false,
  stats: null,
  latestExecutions: {},
  executionsByJobId: {},
  recentExecutions: [],
  selectedJobId: null,
  filterMode: 'all',
  locationFilter: 'all',
  searchQuery: '',
  isLoading: false,
  isEditorOpen: false,
  editingJobId: null,
  copyingJobId: null,
  error: null,

  setFilterMode: (mode) => {
    set({ filterMode: mode });
    void get().loadJobs();
  },
  setLocationFilter: (filter) => set((state) => ({
    locationFilter: filter,
    selectedJobId: resolveSelectedCronJobId(
      filterVisibleCronJobs(state.jobs, state.searchQuery, filter, currentLanguage()),
      state.selectedJobId,
    ),
  })),
  setSearchQuery: (query) => set((state) => ({
    searchQuery: query,
    selectedJobId: resolveSelectedCronJobId(
      filterVisibleCronJobs(state.jobs, query, state.locationFilter, currentLanguage()),
      state.selectedJobId,
    ),
  })),
  selectJob: (jobId) => set((state) => {
    if (!jobId) return { selectedJobId: null };
    const hasActiveFilter = state.searchQuery.trim().length > 0
      || state.locationFilter !== 'all'
      || state.filterMode !== 'all';
    if (!hasActiveFilter) {
      return { selectedJobId: jobId };
    }
    const visibleJobs = filterVisibleCronJobs(
      state.jobs,
      state.searchQuery,
      state.locationFilter,
      currentLanguage(),
    );
    if (visibleJobs.some((job) => job.id === jobId)) {
      return { selectedJobId: jobId };
    }
    const resetFilterMode = state.filterMode !== 'all';
    return {
      searchQuery: '',
      locationFilter: 'all',
      ...(resetFilterMode ? { filterMode: 'all' as const, jobs: state.allJobs.length > 0 ? state.allJobs : state.jobs } : {}),
      selectedJobId: jobId,
    };
  }),

  openCreateEditor: () => set({ isEditorOpen: true, editingJobId: null, copyingJobId: null }),
  openEditEditor: (jobId) => set({ isEditorOpen: true, editingJobId: jobId, copyingJobId: null }),
  openCopyEditor: (jobId) => set({ isEditorOpen: true, editingJobId: null, copyingJobId: jobId }),
  closeEditor: () => set({ isEditorOpen: false, editingJobId: null, copyingJobId: null }),

  loadJobs: async () => {
    const { filterMode } = get();
    set({ isLoading: true, error: null });

    const filter = filterMode === 'all' ? undefined : { enabled: filterMode === 'enabled' };
    const filteredJobsPromise = cronClient.listJobs(filter);
    // The visible task list may be filtered; run records still need the complete catalog
    // so a disabled task is not mistaken for a deleted one.
    const allJobsPromise = filterMode === 'all' ? filteredJobsPromise : cronClient.listJobs();
    const [filteredResult, allResult] = await Promise.allSettled([filteredJobsPromise, allJobsPromise]);

    if (filteredResult.status === 'fulfilled') {
      const jobs = filteredResult.value;
      const latestPairs = await Promise.all(
        jobs.map(async (job) => [job.id, await loadLatestExecution(job.id)] as const)
      );
      const latestExecutions = Object.fromEntries(latestPairs);

      set((state) => {
        const visibleJobs = filterVisibleCronJobs(
          jobs,
          state.searchQuery,
          state.locationFilter,
          currentLanguage(),
        );
        return {
          jobs,
          latestExecutions,
          selectedJobId: resolveSelectedCronJobId(visibleJobs, state.selectedJobId),
        };
      });
    } else {
      logger.error('Failed to load cron jobs', filteredResult.reason);
      set({
        error: filteredResult.reason instanceof Error ? filteredResult.reason.message : 'Failed to load cron jobs',
      });
    }

    if (allResult.status === 'fulfilled') {
      set({ allJobs: allResult.value, jobNamesLoaded: true });
    } else {
      logger.warn('Failed to load complete cron job catalog', {
        errorMessage: allResult.reason instanceof Error ? allResult.reason.message : String(allResult.reason),
      });
    }

    set({ isLoading: false });
  },

  loadStats: async () => {
    try {
      const stats = await cronClient.getStats();
      set({ stats });
    } catch (error) {
      logger.error('Failed to load cron stats', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to load cron stats',
      });
    }
  },

  loadExecutions: async (jobId, limit = 20) => {
    try {
      const executions = await cronClient.getExecutions(jobId, limit);
      // host 契约返回旧→新（cronPersistence LIMIT+reverse），store 统一归一成新→旧（FB-591）。
      const sorted = [...executions].sort(
        (a, b) => b.scheduledAt - a.scheduledAt || (b.startedAt ?? 0) - (a.startedAt ?? 0)
      );
      set((state) => ({
        executionsByJobId: {
          ...state.executionsByJobId,
          [jobId]: sorted,
        },
        latestExecutions: {
          ...state.latestExecutions,
          [jobId]: sorted[0] ?? null,
        },
      }));
    } catch (error) {
      logger.error('Failed to load cron executions', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to load cron executions',
      });
    }
  },

  loadRecentExecutions: async (limit = 50) => {
    try {
      const recentExecutions = await cronClient.getRecentExecutions(limit);
      set({ recentExecutions });
    } catch (error) {
      logger.error('Failed to load recent cron executions', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to load recent cron executions',
      });
    }
  },

  syncRunningExecutions: async () => {
    try {
      const recent = await cronClient.getRecentExecutions(50);
      const byId = new Map(recent.map((execution) => [execution.id, execution]));
      let changed = false;
      set((state) => {
        const latestExecutions = { ...state.latestExecutions };
        let latestChanged = false;
        for (const [jobId, known] of Object.entries(latestExecutions)) {
          const fresh = known ? byId.get(known.id) : undefined;
          if (fresh && fresh.status !== known?.status) {
            latestExecutions[jobId] = fresh;
            latestChanged = true;
          }
        }
        const recentChanged = JSON.stringify(recent) !== JSON.stringify(state.recentExecutions);
        changed = recentChanged || latestChanged;
        if (!changed) return state;
        return {
          ...(recentChanged ? { recentExecutions: recent } : {}),
          ...(latestChanged ? { latestExecutions } : {}),
        };
      });
      if (changed) {
        const { selectedJobId } = get();
        await Promise.all([
          get().loadStats(),
          ...(selectedJobId ? [get().loadExecutions(selectedJobId)] : []),
        ]);
      }
    } catch (error) {
      logger.warn('Failed to sync running cron executions', { error });
    }
  },

  refresh: async () => {
    await Promise.all([get().loadJobs(), get().loadStats()]);
    const { selectedJobId } = get();
    if (selectedJobId) {
      await get().loadExecutions(selectedJobId);
    }
  },

  createJob: async (input) => {
    const created = await cronClient.createJob(input);
    await get().refresh();
    set((state) => {
      const candidateJobs = state.jobs.some((job) => job.id === created.id)
        ? state.jobs
        : [created, ...state.jobs];
      const visibleJobs = filterVisibleCronJobs(
        candidateJobs,
        state.searchQuery,
        state.locationFilter,
        currentLanguage(),
      );
      return {
        selectedJobId: resolveSelectedCronJobId(visibleJobs, created.id),
        // 角色绑定任务保存后编辑器保持打开：组件切到「已保存」复述视图，Done 才关
        // （N-ROLE-ROUTINE-RESTATE）。这里若照旧落 isEditorOpen:false，Modal 会连带
        // 复述视图一起卸载，视图永远出不来。webhook 任务同理：一次性链接卡（N-CRON-WEBHOOK-CLOUD-HOOK-FU1）。
        ...(isRoleBoundCronJob(created) || isWebhookCronJob(created)
          ? {}
          : { isEditorOpen: false, editingJobId: null, copyingJobId: null }),
      };
    });
    return created;
  },

  updateJob: async (jobId, updates) => {
    const updated = await cronClient.updateJob(jobId, updates);
    await get().refresh();
    set({
      ...(updated && isRoleBoundCronJob(updated)
        ? {}
        : { isEditorOpen: false, editingJobId: null, copyingJobId: null }),
    });
    return updated;
  },

  deleteJob: async (jobId) => {
    const ok = await cronClient.deleteJob(jobId);
    if (ok) {
      set((state) => {
        const nextJobs = state.jobs.filter((job) => job.id !== jobId);
        const visibleJobs = filterVisibleCronJobs(
          nextJobs,
          state.searchQuery,
          state.locationFilter,
          currentLanguage(),
        );
        const nextExecutions = { ...state.executionsByJobId };
        const nextLatest = { ...state.latestExecutions };
        delete nextExecutions[jobId];
        delete nextLatest[jobId];
        return {
          jobs: nextJobs,
          executionsByJobId: nextExecutions,
          latestExecutions: nextLatest,
          selectedJobId: resolveSelectedCronJobId(
            visibleJobs,
            state.selectedJobId === jobId ? null : state.selectedJobId,
          ),
        };
      });
      await get().refresh();
    }
    return ok;
  },

  triggerJob: async (jobId) => {
    const pending = cronClient.triggerJob(jobId);
    const refresh = () => Promise.all([get().loadExecutions(jobId), get().loadStats()]);
    // The host persists a running execution before the long-running IPC settles.
    // Retry discovery while it is pending in case the first read races persistence.
    const timer = setInterval(() => { void refresh(); }, 2000);
    void refresh();
    try {
      return await pending;
    } finally {
      clearInterval(timer);
      await refresh();
    }
  },

  setEventActionMode: async (jobId, mode) => {
    const updated = await cronClient.setEventActionMode(jobId, mode);
    if (updated) {
      set((state) => ({ jobs: state.jobs.map((job) => (job.id === jobId ? updated : job)) }));
    }
    return updated;
  },
}));
