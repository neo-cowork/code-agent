// 回复下方记忆来源行的「不对 / 过时了」负反馈（N-MEM-SOURCE-WRONG-FEEDBACK）。
// 落点：DB 行 metadata.injectionFeedback（与 metadata.memoryEntry 平级——镜像重建与面板
// 编辑回写都会展开 ...existing.metadata，标记随行存活）。只影响自动注入：memoryInjectionPauses
// 对带 kind 的行优先返回 user_wrong / user_outdated；MemoryRead、搜索、面板编辑照常。
// 撤销（clear）只清 metadata，绝不 recordMemoryAccess——那是「恢复用量淘汰」的语义，
// 会凭空记一次使用。count 是累计被标记次数，撤销不清零。

import {
  createLogger,
} from '../services/infra/logger';
import type {
  MemoryChangeJournalContext,
  MemoryInjectionFeedbackMetadata,
  MemoryInjectionUserFlagKind,
} from '../../shared/contract/memory';
import { storedMemoryToEntry, type MemoryEntryDatabase } from './memoryEntryRuntime';

const logger = createLogger('MemoryInjectionFeedback');

/** 面板动作的 journal actor：与 memory.ipc 的 PANEL_JOURNAL 同口径（用户手动触发） */
const USER_MANUAL_JOURNAL: MemoryChangeJournalContext = { actor: 'user_manual' };

/** 与 memoryInjectionPauses / listUnifiedMemoryEntries 的 DB 侧候选窗口同宽 */
const SCAN_LIMIT = 500;

type FeedbackRow = ReturnType<MemoryEntryDatabase['listMemories']>[number];

function scanRows(db: MemoryEntryDatabase): FeedbackRow[] {
  return db.listMemories({
    includeArchived: true,
    includeCandidates: true,
    limit: SCAN_LIMIT,
    orderBy: 'updated_at',
    orderDir: 'DESC',
  });
}

/** 安全读行上的负反馈标记；形状不对按无标记处理（fail-open，不拦注入）。 */
export function readInjectionFeedback(
  metadata: Record<string, unknown> | null | undefined,
): MemoryInjectionFeedbackMetadata | null {
  const value = metadata?.injectionFeedback;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind === 'wrong' || record.kind === 'outdated' ? record.kind : undefined;
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : undefined;
  const count = typeof record.count === 'number' && Number.isFinite(record.count)
    ? Math.max(0, Math.floor(record.count))
    : undefined;
  if (kind === undefined && at === undefined && count === undefined) return null;
  return { ...(kind ? { kind } : {}), ...(at !== undefined ? { at } : {}), ...(count !== undefined ? { count } : {}) };
}

function findRow(db: MemoryEntryDatabase, entryId: string): FeedbackRow | null {
  return scanRows(db).find((candidate) => storedMemoryToEntry(candidate).id === entryId) ?? null;
}

/** 记一次负反馈：置 kind/at 并给 count +1；经 updateMemory 落 metadata，journal actor user_manual。 */
export function flagMemoryInjection(
  db: MemoryEntryDatabase,
  entryId: string,
  kind: MemoryInjectionUserFlagKind,
  now: number = Date.now(),
): boolean {
  try {
    const row = findRow(db, entryId);
    if (!row) return false;
    const previous = readInjectionFeedback(row.metadata);
    const feedback: MemoryInjectionFeedbackMetadata = {
      kind,
      at: now,
      count: (previous?.count ?? 0) + 1,
    };
    db.updateMemory(row.id, {
      metadata: { ...row.metadata, injectionFeedback: feedback },
    }, USER_MANUAL_JOURNAL);
    return true;
  } catch (error) {
    logger.warn('[MemoryInjectionFeedback] flag write failed', { entryId, kind, error: String(error) });
    return false;
  }
}

/**
 * 撤销负反馈：只清 kind/at（count 留作累计），不触碰 access_count。
 * 当前没有标记时返回 false（幂等无害：面板只在标记暂停时给撤销入口）。
 */
export function clearMemoryInjectionFlag(
  db: MemoryEntryDatabase,
  entryId: string,
): boolean {
  try {
    const row = findRow(db, entryId);
    if (!row) return false;
    const previous = readInjectionFeedback(row.metadata);
    if (!previous?.kind) return false;
    const feedback: MemoryInjectionFeedbackMetadata = {
      ...(previous.count !== undefined ? { count: previous.count } : { count: 1 }),
    };
    db.updateMemory(row.id, {
      metadata: { ...row.metadata, injectionFeedback: feedback },
    }, USER_MANUAL_JOURNAL);
    return true;
  } catch (error) {
    logger.warn('[MemoryInjectionFeedback] clear write failed', { entryId, error: String(error) });
    return false;
  }
}

/** 面板「被标记过 N 次」：entryId → 累计次数（只收 count > 0 的行）。读失败 fail-open 空表。 */
export function memoryUserFlagCounts(db: MemoryEntryDatabase | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  if (!db) return counts;
  try {
    for (const row of scanRows(db)) {
      const feedback = readInjectionFeedback(row.metadata);
      if (feedback?.count && feedback.count > 0) {
        counts.set(storedMemoryToEntry(row).id, feedback.count);
      }
    }
  } catch (error) {
    logger.warn('[MemoryInjectionFeedback] flag count scan failed', { error: String(error) });
    counts.clear();
  }
  return counts;
}
