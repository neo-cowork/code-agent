// ============================================================================
// 审批响应投递链路（web 路径）——2026-07-26 真机「点允许点不动」的回归门
// ============================================================================
//
// 判据一律是**真实行为**：等在 requestPermission 上的那个 Promise 到底有没有被放行，
// 而不是「某个函数有没有被调到」。真 TaskManager + 真 AgentOrchestrator + 真登记路径，
// 只有 configService 是 stub。
//
// 真因回顾：web 路径原本把这个 channel 转发给 agent.ipc.ts 的 legacy handler，
// 而 webServer 给它的 `getAppService()` 恒为 null ⇒ 生产上必抛 "Agent not initialized"。
// 第 5 个用例专门钉这一点：Map 里预置一个「一被调到就抛」的旧 handler，安装后必须绕开它。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installPermissionResponseHandler } from '../../../src/web/webPermissionResponseHandler';
import { initTaskManager, type TaskManager } from '../../../src/host/task/TaskManager';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { AgentOrchestrator } from '../../../src/host/agent/agentOrchestrator';
import type { PendingDevPermissionRequest } from '../../../src/web/routes/dev';
import type { PermissionAskResult } from '../../../src/shared/contract';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import {
  registerForegroundPermissionIsland,
  unregisterForegroundPermissionIsland,
} from '../../../src/web/foregroundPermissionRegistry';

// 只替换会话库读取（数据层）；审批中继链路（TaskManager / orchestrator / 权限岛 / web handler）全真
vi.mock('../../../src/host/task/backgroundTaskSessionContext', () => ({
  getBackgroundTaskSessionContext: async () => null,
}));

type Handler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;
type IpcResult = { success: boolean; data?: unknown; error?: { code: string; message: string } };

const configServiceStub = {
  getSettings: () => ({
    permissions: {
      autoApprove: { read: true, write: false, execute: false, network: false },
      devModeAutoApprove: false,
    },
    models: { default: 'openai', providers: {}, routing: {} },
  }),
  getApiKey: () => '',
  getServiceApiKey: () => '',
  // N-L10S3: 权限岛接线调真 ConfigService 的守卫方法，stub 必须同形状（缺了会 TypeError 而非 typecheck 红，因为下面是 as never 注入）
  isDevModeAutoApproveEnabled: () => false,
};

/**
 * 从 ToolExecutor 取构造时注入的生产登记入口；它实际绑定到
 * OrchestratorPermissionIsland.requestPermission，而非已经搬走的 orchestrator 方法。
 */
function requestPermission(
  orchestrator: AgentOrchestrator,
): (request: Record<string, unknown>) => Promise<PermissionAskResult> {
  return (orchestrator as unknown as {
    toolExecutor: { requestPermission: (request: Record<string, unknown>) => Promise<PermissionAskResult> };
  }).toolExecutor.requestPermission;
}

/** 拿到权限岛内部的真实挂起表；登记仍必须经 ToolExecutor 注入的生产入口。 */
function pendingIds(orchestrator: AgentOrchestrator): string[] {
  return [...(orchestrator as unknown as {
    permissions: { pendingPermissions: Map<string, unknown> };
  }).permissions.pendingPermissions.keys()];
}

describe('审批响应投递链路（web 路径）', () => {
  let handlers: Map<string, Handler>;
  let pendingDevPermissions: Map<string, PendingDevPermissionRequest>;
  type LogFn = ReturnType<typeof vi.fn<(message: string, ...args: unknown[]) => void>>;
  let logger: { info: LogFn; warn: LogFn };
  let taskManager: TaskManager;
  let currentSessionId: string | null;

  const install = () =>
    installPermissionResponseHandler({
      handlers,
      pendingDevPermissions,
      getCurrentSessionId: () => currentSessionId,
      logger,
    });

  const invoke = (requestId: string, response: string, sessionId?: string) =>
    handlers.get(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE)!(null, requestId, response, sessionId) as Promise<IpcResult>;

  const warnText = () => JSON.stringify(logger.warn.mock.calls);

  beforeEach(() => {
    handlers = new Map();
    pendingDevPermissions = new Map();
    logger = { info: vi.fn(), warn: vi.fn() };
    currentSessionId = null;
    taskManager = initTaskManager();
    taskManager.initialize({
      configService: configServiceStub as never,
      onAgentEvent: () => {},
    } as never);
  });

  it('点「允许」真的放行了等在 requestPermission 上的工具调用', async () => {
    const sessionId = 'sess-live';
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    install();

    // 走 ToolExecutor 实际持有的生产登记入口：它自己登记并返回等待中的 Promise
    const approval = requestPermission(orchestrator)({ type: 'file_write', tool: 'Write', sessionId, reason: 'gate' });
    await Promise.resolve();

    const [requestId] = pendingIds(orchestrator);
    expect(requestId).toBeTruthy();

    const result = await invoke(requestId, 'allow', sessionId);
    expect(result.success).toBe(true);
    // 真实行为判据：工具那一侧真的被放行了，而不是「handler 被调用过」
    await expect(approval).resolves.toEqual({ approved: true, approvalSource: 'user' });
  });

  it('拒绝也真的传到了工具那一侧', async () => {
    const sessionId = 'sess-deny';
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    install();

    const approval = requestPermission(orchestrator)({ type: 'command', tool: 'Bash', sessionId, reason: 'gate' });
    await Promise.resolve();

    const [requestId] = pendingIds(orchestrator);
    await invoke(requestId, 'deny', sessionId);
    // 人点的拒绝 ⇒ denialSource 必须是 user（机器拒的走别的来源，见 ADR-057）
    await expect(approval).resolves.toEqual({ approved: false, denialSource: 'user' });
  });

  it('不存在的 requestId：报 PENDING_PERMISSION_NOT_FOUND，且日志指名道姓', async () => {
    const sessionId = 'sess-unknown-req';
    taskManager.getOrCreateCurrentOrchestrator(sessionId);
    install();

    const result = await invoke('no-such-request', 'allow', sessionId);
    expect(result.success).toBe(false);
    expect(['PENDING_PERMISSION_NOT_FOUND', 'NO_ACTIVE_ORCHESTRATOR']).toContain(result.error?.code);
    expect(warnText()).toContain('no-such-request');
  });

  it('该会话没有活跃 orchestrator：报 NO_ACTIVE_ORCHESTRATOR，日志同时点名 requestId 与 sessionId', async () => {
    install();

    const result = await invoke('req-x', 'allow', 'sess-never-started');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_ACTIVE_ORCHESTRATOR');
    const text = warnText();
    expect(text).toContain('req-x');
    expect(text).toContain('sess-never-started');
  });

  it('没带 sessionId 且没有当前会话：报 NO_ACTIVE_SESSION 而不是静默成功', async () => {
    install();

    const result = await invoke('req-y', 'allow');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_ACTIVE_SESSION');
    expect(warnText()).toContain('req-y');
  });

  it('绝不再委派给走 AppService 的 legacy handler（web 模式下 AppService 恒为 null）', async () => {
    const sessionId = 'sess-no-delegate';
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    // 模拟 agent.ipc.ts 在 web 依赖下的行为：一被调到就抛，这就是生产上那条 500
    handlers.set(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, () => {
      throw new Error('Agent not initialized');
    });
    install();

    const approval = requestPermission(orchestrator)({ type: 'file_write', tool: 'Write', sessionId, reason: 'gate' });
    await Promise.resolve();

    const [requestId] = pendingIds(orchestrator);
    await expect(invoke(requestId, 'allow', sessionId)).resolves.toMatchObject({ success: true });
    await expect(approval).resolves.toEqual({ approved: true, approvalSource: 'user' });
  });

  it('dev 审批（/api/dev 真审批）仍走原来的 pendingDevPermissions 出口', async () => {
    install();
    const resolve = vi.fn();
    pendingDevPermissions.set('dev-req', {
      request: { sessionId: 'sess-dev' },
      resolve,
      reject: vi.fn(),
      timer: setTimeout(() => {}, 0),
    } as unknown as PendingDevPermissionRequest);

    const result = await invoke('dev-req', 'allow');
    expect(result.success).toBe(true);
    expect(resolve).toHaveBeenCalledWith('allow');
  });

  it('前台审批岛在 TaskManager 之前接到响应，真的放行等待中的工具调用', async () => {
    const sessionId = 'sess-foreground';
    const island = new OrchestratorPermissionIsland({
      getSettings: configServiceStub.getSettings as never,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => true,
      onEvent: () => {},
    });
    registerForegroundPermissionIsland(sessionId, island);
    install();
    try {
      const approval = island.requestPermission({ type: 'file_write', tool: 'Write', sessionId, reason: 'gate', details: {} });
      await Promise.resolve();
      const requestId = island.listPendingRequests()[0]?.id;
      expect(requestId).toBeTruthy();

      await expect(invoke(requestId!, 'allow', sessionId)).resolves.toMatchObject({
        success: true,
        data: { source: 'foreground-permission-island' },
      });
      await expect(approval).resolves.toEqual({ approved: true, approvalSource: 'user' });
    } finally {
      island.drainPendingPermissions();
      unregisterForegroundPermissionIsland(sessionId, island);
    }
  });

  it('同会话前台岛与后台任务并存时，后台审批的响应不被前台岛吞掉', async () => {
    const sessionId = 'sess-mixed';
    const island = new OrchestratorPermissionIsland({
      getSettings: configServiceStub.getSettings as never,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => true,
      onEvent: () => {},
    });
    registerForegroundPermissionIsland(sessionId, island);
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    install();
    try {
      // 审批挂在 TaskManager 的 orchestrator 上，前台岛此刻没有任何挂起项
      const approval = requestPermission(orchestrator)({ type: 'file_write', tool: 'Write', sessionId, reason: 'gate' });
      await Promise.resolve();
      const [requestId] = pendingIds(orchestrator);
      expect(requestId).toBeTruthy();

      const result = await invoke(requestId, 'allow', sessionId);
      // 必须穿过前台岛落到 TaskManager，而不是被岛的 unknown_request 短路成失败
      expect(result).toMatchObject({ success: true, data: { source: 'task-manager' } });
      await expect(approval).resolves.toEqual({ approved: true, approvalSource: 'user' });
    } finally {
      island.drainPendingPermissions();
      unregisterForegroundPermissionIsland(sessionId, island);
    }
  });

  describe('后台 helper 的审批按 requestId 找属主，不信调用方的会话 id（FB-1408）', () => {
    const ownerSession = 'sess-owner';
    const otherSession = 'sess-other';
    let releaseRun: () => void;
    let run: Promise<void>;

    beforeEach(async () => {
      const hold = new Promise<void>((resolve) => { releaseRun = resolve; });
      vi.spyOn(AgentOrchestrator.prototype, 'sendMessage').mockImplementation(() => hold);
      run = taskManager.startBackgroundTask('bg-task-1', ownerSession, 'run in background');
      await vi.waitFor(() => {
        expect((taskManager as unknown as { backgroundRuns: Map<string, unknown> }).backgroundRuns.has('bg-task-1')).toBe(true);
      });
      install();
    });

    afterEach(async () => {
      releaseRun();
      await run;
      vi.restoreAllMocks();
    });

    /** 后台 lane 的审批：sessionId 为 null（与真机日志一致），经真登记入口挂起 */
    async function raiseBackgroundApproval() {
      const background = (taskManager as unknown as {
        backgroundRuns: Map<string, { orchestrator: AgentOrchestrator }>;
      }).backgroundRuns.get('bg-task-1')!;
      const approval = requestPermission(background.orchestrator)({
        type: 'command', tool: 'Bash', sessionId: null, reason: 'bg',
      });
      await vi.waitFor(() => expect(pendingIds(background.orchestrator)).toHaveLength(1));
      const requestId = pendingIds(background.orchestrator)[0];
      // 属主登记由 permission_request 事件的异步落库路径完成；等它到位再点，对应真机「用户看到卡之后才点」
      await vi.waitFor(() => {
        const owners = (taskManager as unknown as { backgroundPermissionOwners: Map<string, string> }).backgroundPermissionOwners;
        expect(owners.get(requestId)).toBe('bg-task-1');
      });
      return { approval, requestId };
    }

    it('调用方没带会话 id、服务端「当前会话」是别的会话 → 仍送达并放行', async () => {
      const { approval, requestId } = await raiseBackgroundApproval();
      currentSessionId = otherSession;
      const result = await invoke(requestId, 'allow');
      expect(result).toMatchObject({ success: true });
      await expect(approval).resolves.toEqual({ approved: true, approvalSource: 'user' });
    });

    it('调用方带了错误的会话 id → 仍送达并放行', async () => {
      const { approval, requestId } = await raiseBackgroundApproval();
      const result = await invoke(requestId, 'allow', otherSession);
      expect(result).toMatchObject({ success: true });
      await expect(approval).resolves.toEqual({ approved: true, approvalSource: 'user' });
    });

    it('未知 requestId 仍不送达（与修复前一致）', async () => {
      await raiseBackgroundApproval();
      currentSessionId = otherSession;
      const result = await invoke('no-such-request', 'allow');
      expect(result.success).toBe(false);
      expect(['PENDING_PERMISSION_NOT_FOUND', 'NO_ACTIVE_ORCHESTRATOR']).toContain(result.error?.code);
    });
  });
});
