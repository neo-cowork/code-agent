// ============================================================================
// 审批卡编辑回流端到端：HTTP 处理器(4 参) → 前台权限岛 → ToolExecutor → 工具 handler
// 工具真正执行时看到的是用户改过的标题，而不是模型原参数。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/host/agent/confirmationGate', () => ({
  getConfirmationGate: () => ({
    buildPreview: () => null,
    assessRiskLevel: () => 'low',
    shouldConfirm: () => false,
  }),
}));

vi.mock('../../../src/host/security/writeIsolation', () => ({
  getWriteIsolationManager: () => ({
    acquire: vi.fn(async () => () => {}),
  }),
  getWriteIsolationScope: () => null,
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { getDenialRegistry } = await import('../../../src/host/security/denialRegistry');
const { resetDecisionHistory } = await import('../../../src/host/security/decisionHistory');
const { computeActionFingerprint } = await import('../../../src/host/security/denialRegistry');

const { installPermissionResponseHandler } = await import('../../../src/web/webPermissionResponseHandler');
const { OrchestratorPermissionIsland } = await import('../../../src/host/agent/orchestratorPermissions');
const { registerForegroundPermissionIsland, unregisterForegroundPermissionIsland } = await import('../../../src/web/foregroundPermissionRegistry');
const { IPC_CHANNELS } = await import('../../../src/shared/ipc');

describe('审批卡改标题 → 工具按改后的标题执行', () => {
  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.getDefinition.mockReturnValue({
      name: 'calendar_update_event',
      description: 'calendar update test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'write',
    });
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
  });

  it('工具 handler 观察到的是编辑后的标题', async () => {
    const sessionId = 'edit-e2e';
    const island = new OrchestratorPermissionIsland({
      getSettings: () => ({ permissions: { autoApprove: { read: true, write: false, execute: false, network: false }, devModeAutoApprove: false } }) as never,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => true,
      onEvent: () => {},
    });
    registerForegroundPermissionIsland(sessionId, island);
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    installPermissionResponseHandler({
      handlers: handlers as never,
      pendingDevPermissions: new Map(),
      getCurrentSessionId: () => sessionId,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const executor = new ToolExecutor({
      requestPermission: ((request: Parameters<typeof island.requestPermission>[0]) => island.requestPermission(request)) as never,
      workingDirectory: '/tmp/workbench',
    });
    executor.setAuditEnabled(false);
    try {
      const run = executor.execute(
        'calendar_update_event',
        { calendar: 'Work', event_uid: 'uid-1', title: 'Quarterly review' },
        { sessionId },
      );
      await vi.waitFor(() => expect(island.listPendingRequests()).toHaveLength(1));
      const requestId = island.listPendingRequests()[0]!.id;
      await handlers.get(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE)!(null, requestId, 'allow', sessionId, { title: 'Quarterly review (final)' });
      const result = await run;
      expect(result.success).toBe(true);
      expect(resolverState.execute).toHaveBeenCalledTimes(1);
      const params = resolverState.execute.mock.calls[0][1] as Record<string, unknown>;
      expect(params.title).toBe('Quarterly review (final)');
      expect(params.event_uid).toBe('uid-1');
    } finally {
      island.drainPendingPermissions();
      unregisterForegroundPermissionIsland(sessionId, island);
    }
  });
});
