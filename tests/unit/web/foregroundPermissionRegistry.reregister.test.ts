// ============================================================================
// reregisterForegroundPermissionIsland —— run 收线后迟到的审批要把岛挂回注册表
// ============================================================================
// N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO 返修 r3：/api/run 收线时后台 lane 的
// 审批可能还没抛（ask 晚于 finalize 几秒）。收线清理看到「岛上无 pending」就把岛
// 注销了；lane 随后抛的审批照常发事件、卡也（在另一修复后）能上屏，但注册表里
// 没有这座岛——快照补全列不出它、点击应答落 unknown_request。真机实证（curl 直
// 打应答通道）：{"code":"PENDING_PERMISSION_NOT_FOUND","outcome":"unknown_request"}。
// 修法：岛在 run 收线后又抛出 permission_request 时把**自己**挂回注册表；绝不回占
// 新 run 已注册的岛（那会让新 run 的审批不可达）。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import {
  registerForegroundPermissionIsland,
  reregisterForegroundPermissionIsland,
  unregisterForegroundPermissionIsland,
  listForegroundPermissionRequests,
  deliverForegroundPermissionResponse,
} from '../../../src/web/foregroundPermissionRegistry';

const configServiceStub = {
  getSettings: () => ({
    permissions: {
      autoApprove: { read: true, write: false, execute: false, network: false },
      devModeAutoApprove: false,
    },
    models: { default: 'openai', providers: {}, routing: {} },
  }),
  isDevModeAutoApproveEnabled: () => false,
};

function makeIsland(): OrchestratorPermissionIsland {
  return new OrchestratorPermissionIsland({
    getSettings: configServiceStub.getSettings as never,
    isDevModeAutoApproveEnabled: configServiceStub.isDevModeAutoApproveEnabled,
    getExecutionTopology: () => 'main',
    hasApprovalUi: () => true,
    onEvent: () => {},
  });
}

function ask(island: OrchestratorPermissionIsland, sessionId: string): Promise<unknown> {
  return island.requestPermission({ type: 'file_write', tool: 'Write', sessionId, reason: 'gate', details: {} });
}

describe('reregisterForegroundPermissionIsland（迟到的后台审批把岛挂回注册表）', () => {
  const sessionId = 'sess-late-ask';

  it('注册表为空时挂回自己：迟到的审批可被发现、可被应答', async () => {
    const island = makeIsland();
    try {
      const approval = ask(island, sessionId);
      await Promise.resolve();
      // 模拟收线时岛上无 pending 的旧时序：直接注销（此时 ask 尚未抛出）
      unregisterForegroundPermissionIsland(sessionId, island);
      expect(listForegroundPermissionRequests()).toHaveLength(0);

      // lane 此刻才抛出审批 → 岛挂回注册表
      reregisterForegroundPermissionIsland(sessionId, island);
      expect(listForegroundPermissionRequests().map((request) => request.sessionId)).toContain(sessionId);

      const requestId = island.listPendingRequests()[0]?.id;
      const outcome = deliverForegroundPermissionResponse(sessionId, requestId!, 'allow');
      expect(outcome).toBe('delivered');
      await expect(approval).resolves.toEqual({ approved: true, approvalSource: 'user' });
    } finally {
      island.drainPendingPermissions();
      unregisterForegroundPermissionIsland(sessionId, island);
    }
  });

  it('已注册的是自己时为幂等 no-op', () => {
    const island = makeIsland();
    try {
      registerForegroundPermissionIsland(sessionId, island);
      expect(() => reregisterForegroundPermissionIsland(sessionId, island)).not.toThrow();
      expect(listForegroundPermissionRequests()).toHaveLength(0);
    } finally {
      unregisterForegroundPermissionIsland(sessionId, island);
    }
  });

  it('绝不回占新 run 的岛：注册表里已是别的岛时不覆盖', () => {
    const oldIsland = makeIsland();
    const newRunIsland = makeIsland();
    try {
      registerForegroundPermissionIsland(sessionId, newRunIsland);
      reregisterForegroundPermissionIsland(sessionId, oldIsland);
      // 新 run 的岛必须原样在位，旧 run 的迟发审批不得把它挤掉
      const pending = listForegroundPermissionRequests();
      expect(pending).toHaveLength(0);
      expect(() => deliverForegroundPermissionResponse(sessionId, 'whatever', 'allow')).not.toThrow();
    } finally {
      unregisterForegroundPermissionIsland(sessionId, newRunIsland);
      unregisterForegroundPermissionIsland(sessionId, oldIsland);
    }
  });
});
