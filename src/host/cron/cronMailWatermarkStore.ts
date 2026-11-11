import { getDatabase } from '../services/core/databaseService';

interface CronMailWatermark {
  binding: string;
  seenKeys: string[];
}

type CronMailWatermarkLoadResult =
  | { status: 'found'; watermark: CronMailWatermark }
  | { status: 'missing' }
  | { status: 'unavailable' };

export interface CronMailWatermarkStore {
  load(jobId: string): CronMailWatermarkLoadResult;
  save(jobId: string, binding: string, keys: readonly string[], updatedAt: number): 'ok' | 'unavailable';
}

interface CronMailWatermarkRow {
  binding: string;
  seen_keys: string;
}

function loadCronMailWatermark(jobId: string): CronMailWatermarkLoadResult {
  try {
    const db = getDatabase().getDb();
    if (!db) return { status: 'unavailable' };
    const row = db.prepare(
      'SELECT binding, seen_keys FROM cron_mail_watermarks WHERE job_id = ?',
    ).get(jobId) as CronMailWatermarkRow | undefined;
    if (!row) return { status: 'missing' };
    const parsed = JSON.parse(row.seen_keys) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((key: unknown) => typeof key === 'string')) {
      throw new Error('cron_mail_watermarks.seen_keys is not a string array');
    }
    return { status: 'found', watermark: { binding: row.binding, seenKeys: parsed as string[] } };
  } catch (error) {
    console.error('[CronMailWatermarkStore] Failed to load watermark:', error);
    return { status: 'unavailable' };
  }
}

function saveCronMailWatermark(
  jobId: string,
  binding: string,
  keys: readonly string[],
  updatedAt: number,
): 'ok' | 'unavailable' {
  try {
    const db = getDatabase().getDb();
    if (!db) return 'unavailable';
    db.prepare(`
      INSERT INTO cron_mail_watermarks (job_id, binding, seen_keys, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        binding = excluded.binding,
        seen_keys = excluded.seen_keys,
        updated_at = excluded.updated_at
    `).run(jobId, binding, JSON.stringify(keys), updatedAt);
    return 'ok';
  } catch (error) {
    console.error('[CronMailWatermarkStore] Failed to save watermark:', error);
    return 'unavailable';
  }
}

export const sqliteCronMailWatermarkStore: CronMailWatermarkStore = {
  load: loadCronMailWatermark,
  save: saveCronMailWatermark,
};
