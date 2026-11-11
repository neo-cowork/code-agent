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

  it('同会话新 run 注册时整岛 drain 旧岛，并对旧岛挂起的后台审批发出 resolved 事件供渲染层收卡', async () => {
    const oldEvents: Array<{ type: string; data: unknown }> = [];
    const oldIsland = new OrchestratorPermissionIsland({
      getSettings: configServiceStub.getSettings as never,
      isDevModeAutoApproveEnabled: configServiceStub.isDevModeAutoApproveEnabled,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => true,
      onEvent: (event) => { oldEvents.push(event); },
    });
    const newRunIsland = makeIsland();
    try {
      registerForegroundPermissionIsland(sessionId, oldIsland);
      const bgApproval = oldIsland.requestPermission({
        type: 'command',
        tool: 'bash',
        sessionId,
        agentId: 'bg-agent-1',
        runId: 'bg-run-1',
        forceConfirm: true,
        details: { command: 'echo bg' },
      });
      const [bgRequest] = oldIsland.listPendingRequests();
      expect(bgRequest).toBeDefined();
      oldEvents.length = 0;

      // 同会话新 run 注册：旧岛被 drain 解除，且发出 resolved 事件让渲染层用 dismissPermissionRequest 收卡
      registerForegroundPermissionIsland(sessionId, newRunIsland);

      await expect(bgApproval).resolves.toEqual({ approved: false, denialSource: 'cancelled' });
      expect(oldEvents).toContainEqual({
        type: 'permission_request',
        data: {
          ...bgRequest,
          resolved: true,
        },
      });
    } finally {
      oldIsland.drainPendingPermissions();
      newRunIsland.drainPendingPermissions();
      unregisterForegroundPermissionIsland(sessionId, newRunIsland);
      unregisterForegroundPermissionIsland(sessionId, oldIsland);
    }
  });

  // N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO-FU2-BROWSER：Browser upload_file 形状（file_read +
  // forceConfirm + browser_action.upload_file）的迟到后台审批，同样要靠挂回注册表才点得到。
  it.each([
    ['allow', { approved: true, approvalSource: 'user' }],
    ['deny', { approved: false, denialSource: 'user' }],
  ] as const)('Browser upload_file 迟到审批：挂回注册表后 %s 可送达', async (decision, expected) => {
    const island = new OrchestratorPermissionIsland({
      getSettings: configServiceStub.getSettings as never,
      isDevModeAutoApproveEnabled: configServiceStub.isDevModeAutoApproveEnabled,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => true,
      onEvent: () => {},
    });
    try {
      const approval = island.requestPermission({
        type: 'file_read',
        tool: 'browser_action.upload_file',
        forceConfirm: true,
        dangerLevel: 'warning',
        sessionId,
        agentId: 'bg-agent-1',
        runId: 'bg-run-1',
        details: { file: '.../invoice.pdf', action: 'upload_file', engine: 'managed', approvalMode: 'host_one_time_exact_file' },
      });
      await Promise.resolve();
      unregisterForegroundPermissionIsland(sessionId, island);
      expect(listForegroundPermissionRequests()).toHaveLength(0);

      reregisterForegroundPermissionIsland(sessionId, island);
      const listed = listForegroundPermissionRequests().find((request) => request.sessionId === sessionId);
      expect(listed?.tool).toBe('browser_action.upload_file');

      expect(deliverForegroundPermissionResponse(sessionId, listed!.id, decision)).toBe('delivered');
      await expect(approval).resolves.toEqual(expected);
    } finally {
      island.drainPendingPermissions();
      unregisterForegroundPermissionIsland(sessionId, island);
    }
  });
});
