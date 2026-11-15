// ============================================================================
// Parked Approval Store - 落库停车审批的渲染端镜像
// ============================================================================
// 重开的会话没有内存里的 pendingPermissionRequest，审批只活在 pending_approvals 表。
// 这里统一拉 listParkedApprovals，保留卡片详情与会话级 toolCallId 集合，
// 供 isToolCallAwaitingApproval 做精确对号。全局只有一个定时器：有组件登记
// 「本会话有未完成调用」才轮询，全部撤销即停。

import { create } from 'zustand';
import { useEffect } from 'react';
import type { ParkedApprovalInboxItem } from '@shared/contract/pendingApproval';
import { sessionAutomationClient } from '../services/sessionAutomationClient';

const POLL_INTERVAL_MS = 2000;

type ParkedSets = Record<string, ReadonlySet<string> | undefined>;

interface ParkedApprovalState {
  bySession: ParkedSets;
  items: ParkedApprovalInboxItem[];
}

const useParkedApprovalStore = create<ParkedApprovalState>(() => ({ bySession: {}, items: [] }));

const watchers = new Map<symbol, string>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

function sameSets(a: ParkedSets, b: ParkedSets): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => {
    const x = a[k];
    const y = b[k];
    if (!x || !y) return false;
    return x.size === y.size && [...x].every((id) => y.has(id));
  });
}

export async function refreshParkedApprovals(): Promise<void> {
  // A response may arrive while a poll still contains the old pending row.
  // Queue the refresh behind it rather than dropping the post-response read.
  if (inflight) {
    await inflight;
    return refreshParkedApprovals();
  }
  inflight = (async () => {
    try {
      const items = await sessionAutomationClient.listParkedApprovals();
      const next: ParkedSets = {};
      for (const item of items ?? []) {
        if (item.status !== 'pending' || !item.sessionId || !item.toolCallId) continue;
        const set = (next[item.sessionId] ??= new Set<string>()) as Set<string>;
        set.add(item.toolCallId);
      }
      const previous = useParkedApprovalStore.getState();
      if (!sameSets(previous.bySession, next) || JSON.stringify(previous.items) !== JSON.stringify(items ?? [])) {
        useParkedApprovalStore.setState({ bySession: next, items: items ?? [] });
      }
    } catch {
      // 拉不到就停在上一拍的真实值，不编状态。
    }
  })();
  try { await inflight; } finally { inflight = null; }
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
function useParkedApprovalWatch(sessionId: string | null | undefined, active: boolean) {
  useEffect(() => {
    if (!sessionId || !active) return undefined;
    const key = Symbol('parked-watch');
    watchers.set(key, sessionId);
    sync();
    return () => {
      watchers.delete(key);
      sync();
    };
  }, [sessionId, active]);
}

export function useParkedToolCallIds(sessionId: string | null | undefined, hasUnfinishedCall: boolean) {
  useParkedApprovalWatch(sessionId, hasUnfinishedCall);
  return useParkedApprovalStore((state) => state.bySession);
}

/** Opening a session also watches approvals when its transcript has no tool rows yet. */
export function useParkedApprovals(sessionId: string | null | undefined) {
  useParkedApprovalWatch(sessionId, Boolean(sessionId));
  return useParkedApprovalStore((state) => state.items);
}
