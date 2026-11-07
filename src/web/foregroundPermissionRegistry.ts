import type { PermissionDeliveryOutcome, PermissionResponse } from '../shared/contract/permission';
import type { OrchestratorPermissionIsland } from '../host/agent/orchestratorPermissions';

/**
 * `/api/run` owns its permission island per run, unlike TaskManager's desktop
 * orchestrator. Keep the active island discoverable by the HTTP response route
 * without letting an older concurrent run unregister the newer one.
 */
const foregroundPermissionIslands = new Map<string, OrchestratorPermissionIsland>();
const permissionStateListeners = new Set<() => void>();

export function onForegroundPermissionStateChange(listener: () => void): () => void {
  permissionStateListeners.add(listener);
  return () => { permissionStateListeners.delete(listener); };
}

function notifyPermissionStateChange(): void {
  for (const listener of [...permissionStateListeners]) listener();
}

export function registerForegroundPermissionIsland(
  sessionId: string,
  island: OrchestratorPermissionIsland,
): void {
  // 同会话新 run 注册时，上一座岛里可能还留着没被裁决的后台 lane 审批（run 收线时被
  // N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO 的收线清理故意放过的）。新用户消息 = 显式改向，
  // 与桌面 orchestrator executeMessage 的 drain 同语义：整岛解除（deny/cancelled），
  // 否则旧岛的 Promise 永远没人能 resolve，后台任务会永久挂死在那次 ask 上。
  const previous = foregroundPermissionIslands.get(sessionId);
  if (previous && previous !== island && previous.hasPendingRequests()) {
    previous.drainPendingPermissions('deny');
  }
  foregroundPermissionIslands.set(sessionId, island);
}

export function unregisterForegroundPermissionIsland(
  sessionId: string,
  island: OrchestratorPermissionIsland,
): void {
  if (foregroundPermissionIslands.get(sessionId) === island) {
    foregroundPermissionIslands.delete(sessionId);
    notifyPermissionStateChange();
  }
}

/**
 * run 收线后迟到的审批把岛挂回注册表（N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO）。
 * /api/run 收线时后台 lane 的审批可能还没抛（ask 晚于 finalize 几秒）：收线清理看到
 * 「岛上无 pending」把岛注销了，lane 随后抛的审批照常发事件，但注册表里没有这座岛
 * ——快照补全列不出它、点击应答落 unknown_request（真机实证）。只在注册表为空或
 * 已是这座岛时挂回；新 run 已注册自己的岛时绝不回占（那会让新 run 的审批不可达）。
 */
export function reregisterForegroundPermissionIsland(
  sessionId: string,
  island: OrchestratorPermissionIsland,
): void {
  const current = foregroundPermissionIslands.get(sessionId);
  if (current && current !== island) return;
  if (current === island) return;
  foregroundPermissionIslands.set(sessionId, island);
  notifyPermissionStateChange();
}

export function listForegroundPermissionRequests() {
  return [...foregroundPermissionIslands.values()].flatMap(island => island.listPendingRequests());
}

export function deliverForegroundPermissionResponse(
  sessionId: string,
  requestId: string,
  response: PermissionResponse,
): PermissionDeliveryOutcome | undefined {
  const island = foregroundPermissionIslands.get(sessionId);
  if (!island) return undefined;
  // 同一会话可能同时有前台 run 和后台任务（delegate_task）在等审批：只有这个
  // requestId 确实登记在前台岛上才由它应答，否则返回 undefined 让调用方继续
  // 投给 TaskManager——否则前台岛的 unknown_request 会把后台审批的点击整个吞掉。
  if (!island.listPendingRequests().some((request) => request.id === requestId)) {
    return undefined;
  }
  const outcome = island.handlePermissionResponse(requestId, response);
  if (outcome !== 'unknown_request' && outcome !== 'storage_unavailable') {
    notifyPermissionStateChange();
  }
  return outcome;
}
