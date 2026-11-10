// ============================================================================
// UsageLedgerRepository — per-request 用量账本（A7，append-only）
// ============================================================================
//
// 逐条落 budgetService 归一化后的 TokenUsage：budgetService.usageHistory 是内存
// 数组，进程重启即丢；DB 侧此前只有 sessions.last_token_usage 单列（覆盖式）。
// 只 INSERT/SELECT，不提供 UPDATE/DELETE（账本不可篡改）。只做基建，不做展示页。

import type BetterSqlite3 from 'better-sqlite3';

type SQLiteRow = Record<string, unknown>;

/** 一条 per-request 用量记录（字段口径见 usageNormalization.ts） */
export interface UsageLedgerEntryInput {
  sessionId?: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** 记录时间戳（毫秒），由调用方传入 */
  recordedAt: number;
  /** 预算归属，缺省 foreground */
  scope?: 'foreground' | 'unattended';
  serviceTier?: string;
}

/** 预算状态读取失败的可区分原因：db 未就绪 vs 读取抛错。 */
export class BudgetStateUnavailableError extends Error {
  constructor(
    readonly reason: 'not_ready' | 'read_failed',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BudgetStateUnavailableError';
  }
}

export interface UsageLedgerEntry extends UsageLedgerEntryInput {
  id: number;
}

function rowToEntry(row: SQLiteRow): UsageLedgerEntry {
  return {
    id: Number(row.id),
    sessionId: (row.session_id as string | null) ?? undefined,
    model: String(row.model),
    provider: String(row.provider),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: row.cache_read_tokens == null ? undefined : Number(row.cache_read_tokens),
    cacheCreationTokens: row.cache_creation_tokens == null ? undefined : Number(row.cache_creation_tokens),
    recordedAt: Number(row.recorded_at),
    scope: row.scope === 'unattended' ? 'unattended' : 'foreground',
    serviceTier: (row.service_tier as string | null) ?? undefined,
  };
}

export class UsageLedgerRepository {
  constructor(private db: BetterSqlite3.Database) {}

  /** 追加一条用量记录（append-only） */
  append(input: UsageLedgerEntryInput): void {
    this.db.prepare(`
      INSERT INTO usage_ledger
        (session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, recorded_at, scope, service_tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId ?? null,
      input.model,
      input.provider,
      input.inputTokens,
      input.outputTokens,
      input.cacheReadTokens ?? null,
      input.cacheCreationTokens ?? null,
      input.recordedAt,
      input.scope ?? 'foreground',
      input.serviceTier ?? null,
    );
  }

  /** 某 scope 自 since（含）起的用量记录，按时间升序 */
  getByScopeSince(scope: string, since: number): UsageLedgerEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM usage_ledger WHERE scope = ? AND recorded_at >= ? ORDER BY recorded_at ASC, id ASC
    `).all(scope, since) as SQLiteRow[];
    return rows.map(rowToEntry);
  }

  getPeriodStart(scope: string): number | null {
    const row = this.db.prepare(`SELECT period_start FROM budget_period_state WHERE scope = ?`).get(scope) as
      { period_start?: number } | undefined;
    return row?.period_start == null ? null : Number(row.period_start);
  }

  setPeriodStart(scope: string, periodStart: number, updatedAt: number): void {
    this.db.prepare(`
      INSERT INTO budget_period_state (scope, period_start, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET period_start = excluded.period_start, updated_at = excluded.updated_at
    `).run(scope, periodStart, updatedAt);
  }

  /** 某会话的用量记录（按时间升序） */
  getBySession(sessionId: string, limit = 500): UsageLedgerEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM usage_ledger WHERE session_id = ? ORDER BY recorded_at ASC, id ASC LIMIT ?
    `).all(sessionId, limit) as SQLiteRow[];
    return rows.map(rowToEntry);
  }

  /** 账本总条数 */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM usage_ledger`).get() as { c?: number };
    return Number(row?.c ?? 0);
  }
}
