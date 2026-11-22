// ============================================================================
// 停靠前已批准的调用：mail_draft 的批准卡在连接器执行之前就问过了，Mail 自动化被拒
// （-1743）后整轮停靠、授权后同一 run 自动续跑，模型会原样重发同一封草稿。这里在
// 停靠时记下「这次调用已批准」，同一 run 里参数完全一致的重发只消费一次，不再弹第二张卡。
// 只放进程内存：服务重启后记录消失，回到再问一次（宁可多问，不可漏问）。
// ============================================================================

const PARKED_APPROVAL_TOOL = 'mail_draft';
const approved = new Map<string, Set<string>>();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function recordParkedCallApproval(runId: string | undefined, tool: string, args: unknown): void {
  if (!runId || tool !== PARKED_APPROVAL_TOOL) return;
  const keys = approved.get(runId) ?? new Set<string>();
  keys.add(canonical(args));
  approved.set(runId, keys);
}

export function consumeParkedCallApproval(runId: string | undefined, tool: string, args: unknown): boolean {
  if (!runId || tool !== PARKED_APPROVAL_TOOL) return false;
  const keys = approved.get(runId);
  if (!keys?.delete(canonical(args))) return false;
  if (keys.size === 0) approved.delete(runId);
  return true;
}

export function clearParkedCallApprovals(runId: string): void {
  approved.delete(runId);
}
