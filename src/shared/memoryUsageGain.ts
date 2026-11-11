// 记忆使用增益：searchMemories 与 recall pack 共用的单一公式（N-MEM-RECALL-PACK-USE-USAGE-WEIGHT）。
// gain = 1 + ALPHA*log1p(accessCount) + BETA*freshness；freshness 在 WINDOW 天内线性降到 0。
// 无使用数据时恒为 1。
import { MEMORY } from './constants';

const DAY_MS = 24 * 60 * 60 * 1000;

export function memoryUsageGain(
  usage: { accessCount?: number | null; lastAccessedAt?: number | null },
  now: number,
): number {
  const windowMs = MEMORY.RECORD_RANK_RECENCY_WINDOW_DAYS * DAY_MS;
  const freshness = usage.lastAccessedAt
    ? Math.max(0, 1 - (now - usage.lastAccessedAt) / windowMs)
    : 0;
  return 1
    + MEMORY.RECORD_RANK_USAGE_ALPHA * Math.log1p(usage.accessCount ?? 0)
    + MEMORY.RECORD_RANK_RECENCY_BETA * freshness;
}
