// ============================================================================
// useAgentRowStallLevels - 代理行静默档位（none/quiet/long）的单一派生点
// ----------------------------------------------------------------------------
// 右栏专家面板的行徽标与输入框上方的「卡住了」提示共用这一份，两处不会各算各的。
// 节拍只在有 working 行时开；审批放行时刻按行 key 在渲染期维护，放行后重开完整软阈值窗口。
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { agentRowStallLevel, type AgentRowStallLevel } from '../utils/agentRowStall';
import type { AgentRow } from '../utils/agentRows';

/** 静默提示的「现在」刷新节拍（UI 本地节拍，阈值本身在 WORKFLOW_STALL_THRESHOLDS）。 */
const AGENT_STALL_HINT_TICK_MS = 5000;

export function useAgentRowStallLevels(rows: readonly AgentRow[]): ReadonlyMap<string, AgentRowStallLevel> {
  const anyWorking = rows.some((row) => row.status === 'working');
  const [hintNow, setHintNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyWorking) return;
    const timer = window.setInterval(() => setHintNow(Date.now()), AGENT_STALL_HINT_TICK_MS);
    return () => window.clearInterval(timer);
  }, [anyWorking]);
  // 在渲染期维护（幂等：只由「上一渲染 held → 本渲染不 held」触发），避免 effect 晚一拍导致放行 tick 闪提示。
  const heldKeysRef = useRef<Set<string>>(new Set());
  const releasedAtRef = useRef<Map<string, number>>(new Map());
  const heldNow = new Set(rows.filter((row) => row.hold === 'approval').map((row) => row.key));
  for (const key of heldKeysRef.current) {
    if (!heldNow.has(key)) releasedAtRef.current.set(key, Date.now());
  }
  for (const key of heldNow) releasedAtRef.current.delete(key);
  heldKeysRef.current = heldNow;
  return new Map(rows.map((row) => [row.key, agentRowStallLevel(row, hintNow, releasedAtRef.current.get(row.key))]));
}
