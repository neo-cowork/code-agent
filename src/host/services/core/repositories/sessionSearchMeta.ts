// ============================================================================
// 会话搜索行元数据 —— 跨会话搜索按命中会话 id 取标题/时间/归档，以及标题子串匹配。
// 从 SessionRepository 外拆成小文件（后者已超行数上限）。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';

export interface SessionSearchMetaRow {
  sessionId: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  archived: boolean;
}

/** null = 不加归属过滤；与 SessionRepository.applyOwnerFilter 同语义。 */
type OwnerFilter = string | null | undefined;

function ownerClause(userId: OwnerFilter, params: unknown[]): string {
  if (userId === undefined) return '';
  if (userId === null) return ' AND s.user_id IS NULL';
  params.push(userId);
  return ' AND s.user_id = ?';
}

function toRow(row: Record<string, unknown>): SessionSearchMetaRow {
  const updatedAt = Number(row.updated_at);
  const createdAt = Number(row.created_at);
  return {
    sessionId: String(row.id),
    title: typeof row.title === 'string' ? row.title : '',
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : createdAt,
    createdAt: Number.isFinite(createdAt) ? createdAt : updatedAt,
    archived: row.status === 'archived',
  };
}

/** 按 id 取未删除、归属匹配的会话元数据；不存在/越权的 id 不出现在结果里。 */
export function getSessionSearchMeta(
  db: BetterSqlite3.Database,
  sessionIds: string[],
  userId: OwnerFilter,
): SessionSearchMetaRow[] {
  const ids = Array.from(new Set(sessionIds));
  if (ids.length === 0) return [];
  const params: unknown[] = [...ids];
  const owner = ownerClause(userId, params);
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.updated_at, s.created_at, s.status FROM sessions s
       WHERE s.id IN (${ids.map(() => '?').join(',')}) AND s.is_deleted = 0${owner}`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(toRow);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 标题子串匹配（大小写不敏感）：未删除、未归档、归属匹配，最近更新优先。 */
export function searchSessionTitles(
  db: BetterSqlite3.Database,
  query: string,
  userId: OwnerFilter,
  limit: number,
): SessionSearchMetaRow[] {
  const needle = query.trim();
  if (!needle) return [];
  const params: unknown[] = [`%${escapeLike(needle)}%`];
  const owner = ownerClause(userId, params);
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.updated_at, s.created_at, s.status FROM sessions s
       WHERE s.title LIKE ? ESCAPE '\\' COLLATE NOCASE
         AND s.is_deleted = 0 AND s.status != 'archived'${owner}
       ORDER BY s.updated_at DESC LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(toRow);
}
