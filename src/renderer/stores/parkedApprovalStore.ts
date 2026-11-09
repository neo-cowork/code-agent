// ============================================================================
// Parked Approval Store - 落库停车审批的渲染端镜像
// ============================================================================
// 重开的会话没有内存里的 pendingPermissionRequest，审批只活在 pending_approvals 表。
// 这里统一拉 listParkedApprovals，按会话暴露「等批准的 toolCallId 集合」，
// 供 isToolCallAwaitingApproval 做精确对号。全局只有一个定时器：有组件登记
// 「本会话有未完成调用」才轮询，全部撤销即停。

import { create } from 'zustand';
import { useEffect } from 'react';
import { sessionAutomationClient } from '../services/sessionAutomationClient';

const POLL_INTERVAL_MS = 2000;

type ParkedSets = Record<string, ReadonlySet<string> | undefined>;

interface ParkedApprovalState {
  bySession: ParkedSets;
}

export const useParkedApprovalStore = create<ParkedApprovalState>(() => ({ bySession: {} }));

const watchers = new Map<symbol, string>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight = false;

function sameSets(a: ParkedSets, b: ParkedSets): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => {
    const x = a[k];
    const y = b[k];
    return Boolean(x && y) && x!.size === y!.size && [...x!].every((id) => y!.has(id));
  });
}

export async function refreshParkedApprovals(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const items = await sessionAutomationClient.listParkedApprovals();
    const next: ParkedSets = {};
    for (const item of items ?? []) {
      if (item.status !== 'pending' || !item.sessionId || !item.toolCallId) continue;
      const set = (next[item.sessionId] ??= new Set<string>()) as Set<string>;
      set.add(item.toolCallId);
    }
    if (!sameSets(useParkedApprovalStore.getState().bySession, next)) {
      useParkedApprovalStore.setState({ bySession: next });
    }
  } catch {
    // 拉不到就停在上一拍的真实值，不编状态。
  } finally {
    inflight = false;
  }
}

function sync(): void {
  if (watchers.size > 0 && !timer) {
    void refreshParkedApprovals();
    timer = setInterval(() => { void refreshParkedApprovals(); }, POLL_INTERVAL_MS);
  } else if (watchers.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 登记「该会话渲染着无 result 的调用」；返回会话级 parked 集合（供 permissionState 使用）。 */
export function useParkedToolCallIds(sessionId: string | null | undefined, hasUnfinishedCall: boolean) {
  useEffect(() => {
    if (!sessionId || !hasUnfinishedCall) return undefined;
    const key = Symbol('parked-watch');
    watchers.set(key, sessionId);
    sync();
    return () => {
      watchers.delete(key);
      sync();
    };
  }, [sessionId, hasUnfinishedCall]);
  return useParkedApprovalStore((state) => state.bySession);
}
