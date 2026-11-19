// ============================================================================
// Cron event stats — 事件自动化的三个累计计数（预筛调用 / 预筛跳过 / 被每小时上限推迟）
// ----------------------------------------------------------------------------
// 详情页一行字用。落 cron_event_stats 表（按任务一行，随任务删除级联清掉）；
// quickTask 不回报 token 用量，所以只数次数，不估金额。落库失败只记日志。
// ============================================================================

import type { CronEventStats } from '../../shared/contract/cron';
import { getDatabase } from '../services/core/databaseService';

export type CronEventStatsDelta = Partial<CronEventStats>;

export interface CronEventStatsStore {
  bump(jobId: string, delta: CronEventStatsDelta, now: number): void;
}

interface StatsRow {
  prefilter_calls: number;
  prefilter_skipped: number;
  held_by_cap: number;
}

export function loadCronEventStats(jobId: string): CronEventStats {
  const empty: CronEventStats = { prefilterCalls: 0, prefilterSkipped: 0, heldByCap: 0 };
  try {
    const db = getDatabase().getDb();
    if (!db) return empty;
    const row = db.prepare(
      'SELECT prefilter_calls, prefilter_skipped, held_by_cap FROM cron_event_stats WHERE job_id = ?',
    ).get(jobId) as StatsRow | undefined;
    if (!row) return empty;
    return {
      prefilterCalls: row.prefilter_calls,
      prefilterSkipped: row.prefilter_skipped,
      heldByCap: row.held_by_cap,
    };
  } catch (error) {
    console.error('[CronService] Failed to load event stats:', error);
    return empty;
  }
}

export const sqliteCronEventStatsStore: CronEventStatsStore = {
  bump(jobId, delta, now) {
    try {
      const db = getDatabase().getDb();
      if (!db) return;
      db.prepare(`
        INSERT INTO cron_event_stats (job_id, prefilter_calls, prefilter_skipped, held_by_cap, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          prefilter_calls = prefilter_calls + excluded.prefilter_calls,
          prefilter_skipped = prefilter_skipped + excluded.prefilter_skipped,
          held_by_cap = held_by_cap + excluded.held_by_cap,
          updated_at = excluded.updated_at
      `).run(jobId, delta.prefilterCalls ?? 0, delta.prefilterSkipped ?? 0, delta.heldByCap ?? 0, now);
    } catch (error) {
      console.error('[CronService] Failed to record event stats:', error);
    }
  },
};
