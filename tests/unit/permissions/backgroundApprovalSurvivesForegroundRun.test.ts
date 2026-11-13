// N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO — host 侧契约（To do 2）
//
// 症状追问：前台 run 结束时，宿主会不会把后台任务（delegate_task / spawn_agent
// run_in_background lane）挂着的审批一起收掉？如果会，那是渲染层之外的第二个根因。
//
// 事实链（grep 为证，见证据档）：
// - 审批的 pending Promise 全部挂在会话 OrchestratorPermissionIsland.pendingPermissions
//   （src/host/agent/orchestratorPermissions.ts），后台 lane 的请求经
//   subagentToolRuntime.requestPermission → canUseTool → legacyCtx.requestPermission
//   落进同一个 island，且带着自己的 { agentId, runId } 身份。
// - drainPendingPermissions 只有两处调用：executeMessage（新用户消息到达，
//   agentOrchestrator.ts:209）与 cancel（agentOrchestrator.ts:323）。前台 run 正常收线
//   （runFinalizer.finalizeRun）只发 agent_complete 事件，不碰 island。
// - 所以「前台 run 结束」对 island 是无操作：后台审批保持 pending；此后任一时刻的
//   handlePermissionResponse 都能送达并唤醒后台 lane。
//
// 本文件把这条契约钉在 island 层：前台 run 结束（时间推进越过一切看门狗）后，
// 后台 lane 的审批仍 pending；approve → 后台任务继续；deny → 后台任务收到拒绝。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings, PermissionAskResult } from '../../../src/shared/contract';

const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

const classificationState = vi.hoisted(() => ({
  resolveToolPermissionClassification: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/tools/toolPermissionClassification', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/tools/toolPermissionClassification')>(
    '../../../src/host/tools/toolPermissionClassification',
  );
  return {
    ...actual,
    resolveToolPermissionClassification: classificationState.resolveToolPermissionClassification,
  };
});

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: vi.fn(() => logSpies),
  logger: logSpies,
  default: logSpies,
}));

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';
import { requestBrowserUploadApproval } from '../../../src/host/tools/vision/browserUploadApproval';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { WORKTREE_BASE_DIR } from '../../../src/host/agent/agentWorktreePath';
import { withSubagentRunOwner } from '../../../src/host/agent/subagentRunOwner';
import { getApplicationRunRegistry, resetApplicationRunRegistryForTests } from '../../../src/host/app/applicationRunRegistry';
import { assertSurfaceRunOwner } from '../../../src/host/services/surfaceExecution/surfaceRunOwnership';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

function isStillPending(promise: Promise<PermissionAskResult>): Promise<boolean> {
  const marker = Symbol('pending');
  return Promise.race([promise, Promise.resolve(marker)]).then((result) => result === marker);
}

/**
 * 后台 lane（spawn_agent run_in_background）发起的审批：请求带 lane 身份
 * agentId/runId（subagentToolRuntime.requestPermission 把 identity 摊进请求），
 * bash 类 ask+forceConfirm（后台子代理标 async_agent 的既有口径）。
 */
function beginBackgroundLaneApproval() {
  const events: AgentEvent[] = [];
  const island = new OrchestratorPermissionIsland({
    getSettings: settings,
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'async_agent',
    hasApprovalUi: () => true,
    onEvent: (event) => events.push(event),
  });
  const promise = island.requestPermission({
    type: 'command',
    tool: 'bash',
    details: { command: 'mkdir -p ~/outside-workspace' },
    sessionId: 'bg-card-session',
    agentId: 'bg-agent-1',
    runId: 'bg-run-1',
    forceConfirm: true,
  });
  const [request] = island.listPendingRequests();
  if (!request) throw new Error('permission request was not registered');
  return { island, promise, request, events };
}

describe('前台 run 结束后，后台 lane 的审批在宿主仍 pending（N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPermissionModeManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPermissionModeManager();
  });

  it('前台 run 收线（island 不被触碰）后审批仍 pending，lane 身份随事件下发', async () => {
    const { island, promise, request, events } = beginBackgroundLaneApproval();

    // 宿主在前台 run 正常收线时对 island 无任何调用；把时钟推过一切看门狗/提醒档，
    // 证明没有任何超时会替用户裁决这条后台审批。
    await vi.advanceTimersByTimeAsync(31 * 60_000);

    expect(await isStillPending(promise)).toBe(true);
    const stillListed = island.listPendingRequests().find((entry) => entry.id === request.id);
    expect(stillListed).toBeDefined();
    // lane 身份原样透传：渲染层靠它区分「后台任务的卡」与前台请求。
    expect(stillListed?.agentId).toBe('bg-agent-1');
    expect(stillListed?.runId).toBe('bg-run-1');
    const raised = events.find((event) => event.type === 'permission_request');
    expect(raised).toBeDefined();
  });

  it('迟到的批准送达宿主，后台任务的审批 Promise 以放行收尾（后台任务继续）', async () => {
    const { island, promise, request } = beginBackgroundLaneApproval();

    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(await isStillPending(promise)).toBe(true);

    const outcome = island.handlePermissionResponse(request.id, 'allow');
    expect(outcome).toBe('delivered');

    const result = await promise;
    expect(result.approved).toBe(true);
  });

  it('拒绝送达后后台任务收到拒绝、审批 Promise 以拒绝收尾（后台任务停在这一步）', async () => {
    const { island, promise, request } = beginBackgroundLaneApproval();

    const outcome = island.handlePermissionResponse(request.id, 'deny');
    expect(outcome).toBe('delivered');

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.denialSource).toBe('user');
    expect(island.listPendingRequests()).toHaveLength(0);
  });

  it('run 收线清理（skipBackgroundLanes）只拒前台请求，后台 lane 的审批留活且仍可应答', async () => {
    const events: AgentEvent[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: settings,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => true,
      onEvent: (event) => events.push(event),
    });
    const backgroundPromise = island.requestPermission({
      type: 'command',
      tool: 'bash',
      details: { command: 'echo bg' },
      sessionId: 'run-end-session',
      agentId: 'bg-agent-1',
      runId: 'bg-run-1',
      forceConfirm: true,
    });
    const foregroundPromise = island.requestPermission({
      type: 'file_write',
      tool: 'Write',
      details: { path: '/tmp/run-end-fg.txt' },
      sessionId: 'run-end-session',
      forceConfirm: true,
    });
    expect(island.listPendingRequests()).toHaveLength(2);

    // /api/run 收线 finally 的同款调用：skipBackgroundLanes。
    island.drainPendingPermissions('deny', { skipBackgroundLanes: true });

    // 前台请求按原样被机器拒绝；后台 lane 的审批原样 pending、迟到的点击仍能送达。
    const foregroundResult = await foregroundPromise;
    expect(foregroundResult.approved).toBe(false);
    expect(foregroundResult.denialSource).toBe('cancelled');
    expect(await isStillPending(backgroundPromise)).toBe(true);
    expect(island.hasPendingRequests()).toBe(true);

    const [bgRequest] = island.listPendingRequests();
    expect(bgRequest?.agentId).toBe('bg-agent-1');
    const outcome = island.handlePermissionResponse(bgRequest!.id, 'allow');
    expect(outcome).toBe('delivered');
    expect((await backgroundPromise).approved).toBe(true);
    expect(island.hasPendingRequests()).toBe(false);
  });

  it('整岛 drain（取消/断连/新消息到达）对每条被解除的请求发出 resolved permission_request 以便渲染层收卡', async () => {
    const events: AgentEvent[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: settings,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => true,
      onEvent: (event) => events.push(event),
    });
    const backgroundPromise = island.requestPermission({
      type: 'command',
      tool: 'bash',
      details: { command: 'echo bg-drain' },
      sessionId: 'drain-session',
      agentId: 'bg-agent-1',
      runId: 'bg-run-1',
      forceConfirm: true,
    });
    const [bgRequest] = island.listPendingRequests();
    expect(bgRequest).toBeDefined();
    events.length = 0;

    // 取消 / SSE 断连 / 同会话新 run 注册：整岛 drain
    island.drainPendingPermissions('deny');

    const result = await backgroundPromise;
    expect(result.approved).toBe(false);
    expect(result.denialSource).toBe('cancelled');
    expect(island.hasPendingRequests()).toBe(false);
    expect(events).toContainEqual({
      type: 'permission_request',
      data: {
        ...bgRequest,
        resolved: true,
      },
    });
  });
});

// N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO-FU2-BROWSER：Browser upload_file 形状的同一契约。
// 请求形状与 requestBrowserUploadApproval 发出的一致（file_read + forceConfirm +
// tool 'browser_action.upload_file'）；子代理路径走真 createSubagentToolRuntime 的 executor。
describe('后台子代理 Browser upload_file 审批：前台 run 结束后仍 pending，批准继续、拒绝终止', () => {
  const tmpDirs: string[] = [];
  let invoice = '';

  beforeEach(() => {
    vi.useFakeTimers();
    resetPermissionModeManager();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    classificationState.resolveToolPermissionClassification.mockReset();
    classificationState.resolveToolPermissionClassification.mockResolvedValue({
      decision: 'ask',
      reason: 'test classifier ask',
      confidence: 0.5,
      cached: false,
      traceStep: {
        layer: 'permission_classifier', rule: 'test-ask', result: 'ask',
        reason: 'test classifier ask', durationMs: 0, timestamp: Date.now(),
      },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-browser-upload-'));
    tmpDirs.push(dir);
    invoice = path.join(dir, 'invoice.pdf');
    fs.writeFileSync(invoice, '%PDF-1.4 invoice');
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPermissionModeManager();
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function beginBrowserUploadApproval(ownedContext?: SubagentExecutionContext, repo?: PendingApprovalRepository) {
    const events: AgentEvent[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: settings,
      injectedPendingApprovalRepo: repo,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => true,
      onEvent: (event) => events.push(event),
    });
    const context = {
      sessionId: 'bg-browser-session',
      cwd: path.dirname(invoice),
      ...ownedContext,
      // 生产接线：子代理 context.permission.request 落进会话 island。
      permission: { request: (request: Parameters<typeof island.requestPermission>[0]) => island.requestPermission(request) },
      resolver: { getDefinition: resolverState.getDefinition },
    } as unknown as SubagentExecutionContext;
    resolverState.getDefinition.mockImplementation((name: string) => name === 'Browser'
      ? {
        name: 'Browser',
        description: 'Browser',
        inputSchema: { type: 'object', properties: { action: { type: 'string' }, file: { type: 'string' } }, required: ['action'] },
        requiresPermission: false,
        permissionLevel: 'read',
      }
      : undefined);
    // Browser 工具体：与 browserAction upload_file 分支同一入口 requestBrowserUploadApproval，
    // 收到的 ToolContext.requestPermission 就是 createSubagentToolRuntime 装配的那个。
    resolverState.execute.mockImplementation(async (_name: string, params: { file: string }, toolContext: Parameters<typeof requestBrowserUploadApproval>[0]['context']) => {
      if (ownedContext) assertSurfaceRunOwner({
        runRegistry: getApplicationRunRegistry(),
        identity: { conversationId: toolContext.sessionId!, runId: toolContext.runId!, agentId: toolContext.agentId! },
        surface: 'browser', provider: 'managed', access: 'active',
      });
      const approval = await requestBrowserUploadApproval({
        filePath: params.file,
        context: { ...toolContext, currentToolCallId: 'call-upload-1' },
        engine: 'managed',
      });
      return approval.approved
        ? { success: true, output: 'upload approved' }
        : { success: false, error: approval.reason };
    });
    const { executor } = createSubagentToolRuntime({
      context,
      sessionId: 'bg-browser-session',
      effectiveMode: 'default',
      identity: { agentId: 'bg-agent-1', runId: ownedContext?.runId ?? 'bg-run-1' },
      allowedToolNames: new Set(['Browser']),
      checkToolExecution: () => true,
    });
    const execution = executor.execute('Browser', { action: 'upload_file', file: invoice }, { sessionId: 'bg-browser-session', agentId: 'bg-agent-1', runId: ownedContext?.runId ?? 'bg-run-1' });
    return { island, execution, events };
  }

  async function raised(island: OrchestratorPermissionIsland) {
    await vi.advanceTimersByTimeAsync(10);
    const [request] = island.listPendingRequests();
    if (!request) throw new Error('browser upload approval was not registered');
    return request;
  }

  it('Browser 请求形状到达 island 并挂起：file_read + forceConfirm + lane 身份，前台结束后仍在', async () => {
    const { island, execution, events } = beginBrowserUploadApproval();
    const request = await raised(island);

    expect(request.type).toBe('file_read');
    expect(request.tool).toBe('browser_action.upload_file');
    expect(request.sessionId).toBe('bg-browser-session');
    expect(request.forceConfirm).toBe(true);
    expect(request.agentId).toBe('bg-agent-1');
    expect(request.runId).toBe('bg-run-1');
    expect(request.details).toMatchObject({ action: 'upload_file', approvalMode: 'host_one_time_exact_file' });

    // 前台 run 收线对 island 无操作；时钟越过一切看门狗后仍 pending。
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(island.listPendingRequests().map((entry) => entry.id)).toContain(request.id);
    expect(events.some((event) => event.type === 'permission_request')).toBe(true);
    expect(await isStillPending(execution as unknown as Promise<PermissionAskResult>)).toBe(true);
  });

  it('前台结束后批准：Browser 动作继续并成功', async () => {
    const { island, execution } = beginBrowserUploadApproval();
    const request = await raised(island);
    await vi.advanceTimersByTimeAsync(31 * 60_000);

    expect(island.handlePermissionResponse(request.id, 'allow')).toBe('delivered');
    const result = await execution;
    expect(result.success).toBe(true);
    expect(result.output).toBe('upload approved');
    expect(island.hasPendingRequests()).toBe(false);
  });

  it('拒绝：Browser 动作终止，结果带 not explicitly approved', async () => {
    const { island, execution } = beginBrowserUploadApproval();
    const request = await raised(island);

    expect(island.handlePermissionResponse(request.id, 'deny')).toBe('delivered');
    const result = await execution;
    expect(result.success).toBe(false);
    expect(result.error).toContain('The selected upload file was not explicitly approved.');
    expect(island.hasPendingRequests()).toBe(false);
  });

  it('run 收线清理（skipBackgroundLanes）不收 Browser 后台卡，之后点击仍送达', async () => {
    const { island, execution } = beginBrowserUploadApproval();
    const request = await raised(island);

    island.drainPendingPermissions('deny', { skipBackgroundLanes: true });
    expect(island.listPendingRequests().map((entry) => entry.id)).toContain(request.id);

    expect(island.handlePermissionResponse(request.id, 'allow')).toBe('delivered');
    expect((await execution).success).toBe(true);
  });

  it.each(['allow', 'deny'] as const)('lane owns Browser after foreground unregister, %s settles and releases owner', async (decision) => {
    const registry = getApplicationRunRegistry();
    const foreground = registry.start({ sessionId: 'bg-browser-session', workspace: path.dirname(invoice) });
    const controller = new AbortController();
    let laneRunId = '';
    let upload: ReturnType<typeof beginBrowserUploadApproval> | undefined;
    const execution = withSubagentRunOwner({
      prompt: 'Attach invoice.pdf to the invoice form in the background',
      config: { name: 'Invoice assistant', systemPrompt: '', availableTools: ['Browser'] },
      context: {
        sessionId: 'bg-browser-session', runId: foreground.context.runId,
        workspace: path.dirname(invoice), cwd: path.dirname(invoice),
        abortSignal: controller.signal,
      } as SubagentExecutionContext,
    }, async ({ context }) => {
      laneRunId = context.runId!;
      expect(laneRunId).not.toBe(foreground.context.runId);
      expect(registry.getBySessionId(context.sessionId)).toBe(foreground);
      registry.unregister(foreground.context.runId, foreground);
      upload = beginBrowserUploadApproval(context);
      const result = await upload.execution;
      return { success: result.success, output: result.output ?? '', error: result.error, toolsUsed: ['Browser'], iterations: 1 };
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(upload).toBeDefined();
    const request = await raised(upload!.island);
    expect(request.runId).toBe(laneRunId);
    expect(registry.resolve({ runId: laneRunId, sessionId: 'bg-browser-session' })).toBeDefined();
    expect(upload!.island.handlePermissionResponse(request.id, decision)).toBe('delivered');
    const result = await execution;
    expect(result.success).toBe(decision === 'allow');
    if (decision === 'deny') expect(result.error).toContain('The selected upload file was not explicitly approved.');
    expect(registry.resolve({ runId: laneRunId })).toBeUndefined();
    expect(() => assertSurfaceRunOwner({ runRegistry: registry,
      identity: { conversationId: 'bg-browser-session', runId: laneRunId, agentId: 'bg-agent-1' },
      surface: 'browser', provider: 'managed', access: 'active',
    })).toThrow('Surface execution owner is not the active RunRegistry handle.');
    resetApplicationRunRegistryForTests();
  });

  it('lane cancellation revokes surface actions, and failure releases its owner', async () => {
    const registry = getApplicationRunRegistry();
    const controller = new AbortController();
    let laneRunId = '';
    await expect(withSubagentRunOwner({
      prompt: 'Attach invoice.pdf',
      config: { name: 'Invoice assistant', systemPrompt: '', availableTools: ['Browser'] },
      context: { sessionId: 'bg-browser-session', cwd: path.dirname(invoice), abortSignal: controller.signal } as SubagentExecutionContext,
    }, async ({ context }) => {
      laneRunId = context.runId!;
      controller.abort('user-cancel');
      await Promise.resolve();
      expect(context.abortSignal.aborted).toBe(true);
      expect(() => assertSurfaceRunOwner({ runRegistry: registry,
        identity: { conversationId: context.sessionId, runId: laneRunId, agentId: 'bg-agent-1' },
        surface: 'browser', provider: 'managed', access: 'active',
      })).toThrow('Surface execution owner is not the active RunRegistry handle.');
      throw new Error('lane ended');
    })).rejects.toThrow('lane ended');
    expect(registry.resolve({ runId: laneRunId })).toBeUndefined();
    resetApplicationRunRegistryForTests();
  });


  it.each(['allow', 'deny'] as const)('background exact-file approval persists until %s, without broadening consent', async (decision) => {
    const insert = vi.fn();
    const resolve = vi.fn(() => 1);
    const { island, execution } = beginBrowserUploadApproval(undefined, { insert, resolve } as unknown as PendingApprovalRepository);
    const request = await raised(island);
    expect(insert).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ id: request.id,
      payload: expect.objectContaining({ tool: 'browser_action.upload_file', type: 'file_read' }),
    }));
    island.drainPendingPermissions('deny', { skipBackgroundLanes: true });
    expect(resolve).not.toHaveBeenCalled();
    expect(island.handlePermissionResponse(request.id, decision)).toBe('delivered');
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ id: request.id, status: decision === 'allow' ? 'approved' : 'rejected' }));
    expect((await execution).success).toBe(decision === 'allow');
    expect(island.handlePermissionResponse(request.id, decision)).toBe('unknown_request');
  });


  it('Browser lane owner uses its isolated worktree without changing executor write authority', async () => {
    const registry = getApplicationRunRegistry();
    fs.mkdirSync(WORKTREE_BASE_DIR, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(WORKTREE_BASE_DIR, 'browser-owner-'));
    tmpDirs.push(cwd);
    const context = { sessionId: 'worktree-session', workspace: path.dirname(invoice), cwd,
      abortSignal: new AbortController().signal,
    } as SubagentExecutionContext;
    await withSubagentRunOwner({ prompt: 'Attach invoice.pdf',
      config: { name: 'Invoice assistant', systemPrompt: '', availableTools: ['Browser'] }, context,
    }, async (request) => {
      const handle = registry.resolve({ runId: request.context.runId });
      expect(handle?.context.cwd).toBe(fs.realpathSync(cwd));
      expect(handle?.context.workspace).toBe(fs.realpathSync(cwd));
      expect(request.context.workspace).toBe(context.workspace);
      expect(request.context.workspaceScope).toBe(context.workspaceScope);
      return { success: true, output: '', toolsUsed: [], iterations: 0 };
    });
    expect(registry.size).toBe(0);
    resetApplicationRunRegistryForTests();
  });

});
