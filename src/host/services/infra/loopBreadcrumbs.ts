// ============================================================================
// Loop breadcrumbs — 事件循环卡顿时的现场线索
// ============================================================================
// SkillWatcher 与 LSP 初始化把「我刚做了什么」写在这里；web 层的 event-loop watchdog
// 在打 stall 警告时读出来拼进同一行。纯内存、O(1) 写入，不做任何 I/O。

const RECENT_SKILL_OPS = 16;

interface SkillWatcherOpRecord {
  op: string;
  startedAt: number;
  /** 未结束的操作为 null（同步卡死时就是这样） */
  endedAt: number | null;
}

const skillWatcherOps: SkillWatcherOpRecord[] = [];
let lspInitializingWorkspace: string | null = null;
let lspPendingRequests = 0;

/** 记录一次 SkillWatcher 生命周期操作（含同步段）；返回结束回调。 */
export function beginSkillWatcherOp(op: string): () => void {
  const record: SkillWatcherOpRecord = { op, startedAt: Date.now(), endedAt: null };
  skillWatcherOps.push(record);
  if (skillWatcherOps.length > RECENT_SKILL_OPS) skillWatcherOps.shift();
  return () => { record.endedAt = Date.now(); };
}

export function setLspInitializingWorkspace(workspace: string | null): void {
  lspInitializingWorkspace = workspace;
}

export function adjustLspPendingRequests(delta: number): void {
  lspPendingRequests = Math.max(0, lspPendingRequests + delta);
}

function describeOp(record: SkillWatcherOpRecord, now: number): Record<string, unknown> {
  return {
    op: record.op,
    started_ago_ms: now - record.startedAt,
    took_ms: record.endedAt === null ? null : record.endedAt - record.startedAt,
  };
}

/** 供 watchdog 使用：最近一次操作 + 窗口内最慢的一次操作 + LSP 状态。 */
export function snapshotLoopBreadcrumbs(sinceMs: number): Record<string, unknown> {
  const now = Date.now();
  const last = skillWatcherOps[skillWatcherOps.length - 1];
  const slowest = skillWatcherOps
    .filter((r) => (r.endedAt ?? now) >= now - sinceMs)
    .reduce<SkillWatcherOpRecord | null>((best, r) => {
      const took = (r.endedAt ?? now) - r.startedAt;
      return !best || took > (best.endedAt ?? now) - best.startedAt ? r : best;
    }, null);
  return {
    skill_watcher_last_op: last ? describeOp(last, now) : null,
    skill_watcher_slowest_op: slowest ? describeOp(slowest, now) : null,
    lsp_initializing_workspace: lspInitializingWorkspace,
    lsp_pending_requests: lspPendingRequests,
  };
}
