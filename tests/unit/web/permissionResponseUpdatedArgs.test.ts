// ============================================================================
// 审批卡「改一改再确认」的 updatedArgs 必须穿过 web 投递链（FB-2606）
// ============================================================================
//
// 病灶：PermissionCard.handleApproval 把编辑结果当第 4 个 IPC 参数发出，
// host 侧 orchestrator / TaskManager / ToolExecutor(applyEditedArgs) 全都支持，
// 唯独 webPermissionResponseHandler.deliver 只解构前 3 个参数——发行版跑的正是
// web 路径，用户在卡上改过的 notes / start_ms 永远进不了工具调用。
//
// 全走生产入口 installPermissionResponseHandler：真 TaskManager + 真 orchestrator
// （或真前台权限岛）+ ToolExecutor 实际持有的 requestPermission 登记入口；
// 链路末尾的日历写回落到真 calendarCreateEventModule + stub 连接器注册表。
// 反向变异：把 deliver 里 args[3] 的解构拿掉，(a) 与 (e) 必红。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({ getDefinition: vi.fn(), execute: vi.fn() }));
const connectorGet = vi.hoisted(() => vi.fn());
const connectorExecute = vi.hoisted(() => vi.fn());
const resumeMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());

// resolver mock 只做名字分发：calendar_create_event 落到真 ToolModule，
// 权限链与 canUseTool 判定全部走生产代码（同 calendarReadGrantAcrossRanges 先例）。
vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({ getDefinition: resolverState.getDefinition, execute: resolverState.execute }),
}));
vi.mock('../../../src/host/connectors', async (orig) => ({
  ...(await orig<object>()),
  getConnectorRegistry: () => ({ get: connectorGet }),
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
  getWriteIsolationManager: () => ({ acquire: vi.fn(async () => () => {}) }),
  getWriteIsolationScope: () => null,
}));
vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
    invalidateForPath: vi.fn(),
    invalidateForWorkspace: vi.fn(),
    clear: vi.fn(),
  }),
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn(), retractNeedsInput: vi.fn() },
}));
vi.mock('../../../src/host/task/backgroundTaskSessionContext', () => ({
  getBackgroundTaskSessionContext: async () => null,
}));
// (d) 要证明「改过的参数绝不送给幸存停车行去重放原始 args」——resume 是这条链的叶子，
// 替身只记调用与否（同 parkedApprovalStorageFailure 替身收口函数的写法）。
vi.mock('../../../src/host/agent/parkedApprovalResume', async (orig) => ({
  ...(await orig<object>()),
  resumeSurvivingParkedApproval: resumeMock,
}));
vi.mock('../../../src/host/agent/parkedApprovalHydration', async (orig) => ({
  ...(await orig<object>()),
  closeDeadParkedApproval: closeMock,
}));

import { installPermissionResponseHandler } from '../../../src/web/webPermissionResponseHandler';
import { initTaskManager, type TaskManager } from '../../../src/host/task/TaskManager';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { AgentOrchestrator } from '../../../src/host/agent/agentOrchestrator';
import type { PendingDevPermissionRequest } from '../../../src/web/routes/dev';
import type { Message, PermissionAskResult } from '../../../src/shared/contract';
import { buildContextTranscriptEntries } from '../../../src/host/agent/runtime/contextAssembly/transcriptProjection';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly/shared';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import type { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { getDenialRegistry } from '../../../src/host/security/denialRegistry';
import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { buildProtocolContext, buildCanUseToolFromLegacy } from '../../../src/host/tools/dispatch/shadowAdapter';
import { calendarCreateEventModule } from '../../../src/host/tools/modules/connectors/calendarCreateEvent';
import type { ToolContext, ToolExecutionResult } from '../../../src/host/tools/types';
import {
  registerForegroundPermissionIsland,
  unregisterForegroundPermissionIsland,
} from '../../../src/web/foregroundPermissionRegistry';

type Handler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;
type IpcResult = { success: boolean; data?: { source?: string; closed?: boolean; resumed?: string }; error?: { code: string; message: string } };

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
  isDevModeAutoApproveEnabled: () => false,
};

const CALENDAR_CREATE_DEFINITION = {
  name: 'calendar_create_event',
  description: 'create calendar event',
  permissionLevel: 'write',
  readOnly: false,
  requiresPermission: true,
  inputSchema: {
    type: 'object',
    properties: {
      calendar: { type: 'string' },
      title: { type: 'string' },
      start_ms: { type: 'number' },
      end_ms: { type: 'number' },
      location: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['title'],
  },
};

const ORIGINAL_START_MS = Date.parse('2026-11-24T14:00:00-08:00');
const EDITED_START_MS = Date.parse('2026-11-24T15:00:00-08:00');
const EDITED_NOTES = 'line 1: bring the quarterly report\nline 2: arrive ten minutes early';
const ORIGINAL_ARGS = {
  calendar: '工作',
  title: 'Project review',
  start_ms: ORIGINAL_START_MS,
  notes: 'bring the quarterly report',
};
const EDITED_ARGS = { notes: EDITED_NOTES, start_ms: EDITED_START_MS };

/** ToolExecutor 实际持有的生产登记入口（绑定到 OrchestratorPermissionIsland.requestPermission）。 */
function requestPermission(
  orchestrator: AgentOrchestrator,
): (request: Record<string, unknown>) => Promise<PermissionAskResult> {
  return (orchestrator as unknown as {
    toolExecutor: { requestPermission: (request: Record<string, unknown>) => Promise<PermissionAskResult> };
  }).toolExecutor.requestPermission;
}

function pendingIds(orchestrator: AgentOrchestrator): string[] {
  return [...(orchestrator as unknown as {
    permissions: { pendingPermissions: Map<string, unknown> };
  }).permissions.pendingPermissions.keys()];
}

function toolExecutorOf(orchestrator: AgentOrchestrator): ToolExecutor {
  return (orchestrator as unknown as { toolExecutor: ToolExecutor }).toolExecutor;
}

describe('审批卡编辑参数经 web 投递链抵达工具调用（FB-2606）', () => {
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

  const invoke = (requestId: string, response: string, sessionId?: string, updatedArgs?: unknown) =>
    handlers.get(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE)!(null, requestId, response, sessionId, updatedArgs) as Promise<IpcResult>;

  beforeEach(() => {
    handlers = new Map();
    pendingDevPermissions = new Map();
    logger = { info: vi.fn(), warn: vi.fn() };
    currentSessionId = null;
    getDenialRegistry().clearAll();
    resetDecisionHistory();
    resumeMock.mockReset();
    resumeMock.mockResolvedValue({ handled: false });
    closeMock.mockReset();
    closeMock.mockReturnValue(false);
    connectorGet.mockReset();
    connectorGet.mockReturnValue({ execute: connectorExecute });
    connectorExecute.mockReset();
    connectorExecute.mockResolvedValue({
      data: {
        uid: 'evt-edited',
        calendar: '工作',
        title: 'Project review',
        startAtMs: EDITED_START_MS,
        endAtMs: EDITED_START_MS + 3_600_000,
        notes: EDITED_NOTES,
      },
    });
    resolverState.getDefinition.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) =>
      name === 'calendar_create_event' ? CALENDAR_CREATE_DEFINITION : undefined);
    resolverState.execute.mockReset();
    resolverState.execute.mockImplementation(async (
      name: string,
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolExecutionResult> => {
      if (name !== 'calendar_create_event') return { success: false, error: `tool not registered: ${name}` };
      const protoCtx = buildProtocolContext({
        sessionId: ctx.sessionId,
        workingDirectory: ctx.workingDirectory,
        legacyCtx: ctx,
        abortSignal: ctx.abortSignal,
      });
      const protoResult = await (await calendarCreateEventModule.createHandler())
        .execute(args, protoCtx, buildCanUseToolFromLegacy(ctx, name));
      if (!protoResult.ok) {
        return { success: false, error: protoResult.error, metadata: { code: protoResult.code, ...(protoResult.meta ?? {}) } };
      }
      return { success: true, output: protoResult.output, result: protoResult.output, metadata: protoResult.meta };
    });
    taskManager = initTaskManager();
    taskManager.initialize({
      configService: configServiceStub as never,
      onAgentEvent: () => {},
    } as never);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('(a) 前台权限岛分支：编辑过的参数原样抵达等待中的 ask，日志带 edited: true', async () => {
    const sessionId = 'sess-edited-foreground';
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
      const approval = island.requestPermission({
        type: 'file_write', tool: 'calendar_create_event', sessionId, reason: 'gate', details: {},
      });
      await Promise.resolve();
      const requestId = island.listPendingRequests()[0]?.id;
      expect(requestId).toBeTruthy();

      const result = await invoke(requestId!, 'allow', sessionId, EDITED_ARGS);
      expect(result).toMatchObject({ success: true, data: { source: 'foreground-permission-island' } });
      await expect(approval).resolves.toEqual({
        approved: true,
        approvalSource: 'user',
        updatedArgs: EDITED_ARGS,
      });
      expect(logger.info).toHaveBeenCalledWith(
        'Permission response delivered (web foreground)',
        expect.objectContaining({ requestId, edited: true }),
      );
    } finally {
      island.drainPendingPermissions();
      unregisterForegroundPermissionIsland(sessionId, island);
    }
  });

  it('(b) TaskManager 分支：编辑过的参数原样抵达等待中的 ask，日志带 edited: true', async () => {
    const sessionId = 'sess-edited-taskmanager';
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    install();

    const approval = requestPermission(orchestrator)({
      type: 'file_write', tool: 'calendar_create_event', sessionId, reason: 'gate',
    });
    await Promise.resolve();
    const [requestId] = pendingIds(orchestrator);
    expect(requestId).toBeTruthy();

    const result = await invoke(requestId, 'allow', sessionId, EDITED_ARGS);
    expect(result).toMatchObject({ success: true, data: { source: 'task-manager' } });
    await expect(approval).resolves.toEqual({
      approved: true,
      approvalSource: 'user',
      updatedArgs: EDITED_ARGS,
    });
    expect(logger.info).toHaveBeenCalledWith(
      'Permission response delivered (web)',
      expect.objectContaining({ requestId, edited: true }),
    );
  });

  it.each([
    ['数组', ['not', 'an', 'object']],
    ['字符串', 'not-an-object'],
    ['数字', 42],
  ])('(c) 非 plain object 的 updatedArgs（%s）：INVALID_UPDATED_ARGS，请求仍可裁决', async (_label, bad) => {
    const sessionId = 'sess-invalid-edited';
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    install();

    const approval = requestPermission(orchestrator)({
      type: 'file_write', tool: 'calendar_create_event', sessionId, reason: 'gate',
    });
    await Promise.resolve();
    const [requestId] = pendingIds(orchestrator);

    const result = await invoke(requestId, 'allow', sessionId, bad);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_UPDATED_ARGS');
    // 挂起请求没被这次坏应答碰掉——之后一次干净的「允许」仍能真正裁决
    expect(pendingIds(orchestrator)).toContain(requestId);
    await expect(invoke(requestId, 'allow', sessionId)).resolves.toMatchObject({ success: true });
    await expect(approval).resolves.toEqual({ approved: true, approvalSource: 'user' });
  });

  it('(d) 死停车行 + 改过的参数：不走恢复执行原始 args，fail-closed 收口', async () => {
    const sessionId = 'sess-edited-parked';
    install();
    // 幸存停车行的恢复路径一旦接手就会按台账里的「原始 args」执行一次：
    // 让替身做真身会做的事，证明带 updatedArgs 时这只手根本没伸过来。
    resumeMock.mockResolvedValue({ handled: true, status: 'executed', resultRef: 'ledger-result' });
    closeMock.mockReturnValue(true);

    const edited = await invoke('dead-parked-request', 'allow', sessionId, EDITED_ARGS);
    expect(resumeMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledWith('dead-parked-request');
    expect(edited).toMatchObject({ success: true, data: { closed: true } });

    // 对照：不带 updatedArgs 时同一请求照旧走恢复（既有行为没坏）
    closeMock.mockClear();
    const plain = await invoke('dead-parked-request', 'allow', sessionId);
    expect(resumeMock).toHaveBeenCalledWith({ requestId: 'dead-parked-request', response: 'allow' });
    expect(closeMock).not.toHaveBeenCalled();
    expect(plain).toMatchObject({ success: true, data: { resumed: 'executed' } });
  });

  it('(e) 全链：审批卡上改的 notes / start_ms 经 web 投递链抵达日历连接器', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const sessionId = 'sess-edited-chain';
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    install();

    const execution = toolExecutorOf(orchestrator).execute('calendar_create_event', { ...ORIGINAL_ARGS }, { sessionId });
    await vi.waitFor(() => expect(pendingIds(orchestrator)).toHaveLength(1));
    const [requestId] = pendingIds(orchestrator);

    const result = await invoke(requestId, 'allow', sessionId, EDITED_ARGS);
    expect(result).toMatchObject({ success: true, data: { source: 'task-manager' } });
    const executed = await execution;
    expect(executed.success).toBe(true);

    const toolResults = [{ ...executed, toolCallId: 'calendar-call' }];
    const messages: Message[] = [{ id: 'calendar-result', role: 'tool', content: JSON.stringify(toolResults), timestamp: Date.now(), toolResults }];
    const ctx = { runtime: { messages }, getBudgetedPersistentSystemContext: () => [] } as unknown as ContextAssemblyCtx;
    const [toolMessage] = buildContextTranscriptEntries(ctx, messages);
    const receipt = await resolverState.execute.mock.results[0].value;
    expect(toolMessage).toMatchObject({
      role: 'tool',
      toolCallId: 'calendar-call',
      content: [
        receipt.output,
        '',
        'The user edited these fields on the approval card. Report the executed values below in place of the ones you proposed.',
        '- Start time: 2026-11-24 15:00 (UTC-8)',
        `- Notes: ${JSON.stringify(EDITED_NOTES)}`,
      ].join('\n'),
    });

    // 判据就是连接器拿到的那一份：notes 是卡上改的两行、start_ms 是卡上改的时间
    expect(connectorExecute).toHaveBeenCalledWith('create_event', {
      ...ORIGINAL_ARGS,
      notes: EDITED_NOTES,
      start_ms: EDITED_START_MS,
    });
    expect(logger.info).toHaveBeenCalledWith(
      'Permission response delivered (web)',
      expect.objectContaining({ requestId, edited: true }),
    );
  });

  it.each([
    ['allow without edits', undefined],
    ['allow with no real change', { notes: ORIGINAL_ARGS.notes }],
  ])('(g) %s preserves the receipt byte for byte', async (_label, updatedArgs) => {
    const sessionId = 'sess-unchanged-chain';
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    install();

    const execution = toolExecutorOf(orchestrator).execute('calendar_create_event', { ...ORIGINAL_ARGS }, { sessionId });
    await vi.waitFor(() => expect(pendingIds(orchestrator)).toHaveLength(1));
    const [requestId] = pendingIds(orchestrator);
    await expect(invoke(requestId, 'allow', sessionId, updatedArgs)).resolves.toMatchObject({ success: true });

    const executed = await execution;
    expect(executed.success).toBe(true);
    const receipt = await resolverState.execute.mock.results[0].value;
    expect(executed.output).toBe(receipt.output);
  });

  it('marks a capped edited value as a truncated preview', async () => {
    const sessionId = 'sess-long-edited-notes';
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    install();

    const notes = 'x'.repeat(600);
    const execution = toolExecutorOf(orchestrator).execute('calendar_create_event', { ...ORIGINAL_ARGS }, { sessionId });
    await vi.waitFor(() => expect(pendingIds(orchestrator)).toHaveLength(1));
    const [requestId] = pendingIds(orchestrator);
    await expect(invoke(requestId, 'allow', sessionId, { notes })).resolves.toMatchObject({ success: true });

    const executed = await execution;
    expect(executed.success).toBe(true);
    expect(executed.output?.split('\n').at(-1)).toBe(`- Notes (truncated preview): "${'x'.repeat(498)}…`);
    expect(connectorExecute).toHaveBeenCalledWith('create_event', { ...ORIGINAL_ARGS, notes });
  });

  it('(f) 全链：原参数省略可选的 calendar（字面复现路径），编辑照样抵达连接器', async () => {
    const sessionId = 'sess-edited-chain-no-calendar';
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    install();

    // 字面复现：模型没传 calendar——只读必填字段不能因「原参数没它」把用户编辑整体拒掉。
    const originalWithoutCalendar = {
      title: ORIGINAL_ARGS.title,
      start_ms: ORIGINAL_START_MS,
      notes: ORIGINAL_ARGS.notes,
    };
    const execution = toolExecutorOf(orchestrator).execute('calendar_create_event', { ...originalWithoutCalendar }, { sessionId });
    await vi.waitFor(() => expect(pendingIds(orchestrator)).toHaveLength(1));
    const [requestId] = pendingIds(orchestrator);

    const result = await invoke(requestId, 'allow', sessionId, EDITED_ARGS);
    expect(result).toMatchObject({ success: true, data: { source: 'task-manager' } });
    await expect(execution).resolves.toMatchObject({ success: true });

    expect(connectorExecute).toHaveBeenCalledWith('create_event', {
      ...originalWithoutCalendar,
      notes: EDITED_NOTES,
      start_ms: EDITED_START_MS,
    });
  });
});
