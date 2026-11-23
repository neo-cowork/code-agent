// 工具体内审批（context.requestPermission）请求归一化：toolExecutor 包装器把空缺的
// sessionId 补成本次执行的 effectiveSessionId（11-22 option A），让无人值守停车、
// 用户原话引用、stall 时钟认得出会话；runId 不补——runId/agentId 在审批链上是
// 「后台 lane 身份」（hasBackgroundRunIdentity 据此停车/跳过收线清理/标 backgroundLane），
// 只由 lane 边界在跨 lane 转发时盖上（subagentToolRuntime 摊 identity、requestHint），
// 本 lane 自产的请求盖上就被误判后台 lane。已带值的请求（canUseTool→shadowAdapter、
// 子代理转发路径）不覆盖也不换对象——permissionAskResults 是 WeakMap，靠同一引用回查。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  definition: undefined as Record<string, unknown> | undefined,
  execute: vi.fn(),
}));
const ledgerState = vi.hoisted(() => ({
  appendPermissionDecision: vi.fn(),
  appendToolExecutionBegin: vi.fn(),
  appendToolExecutionComplete: vi.fn(),
}));
const dbState = vi.hoisted(() => ({
  session: undefined as unknown,
  recentMessages: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: () => resolverState.definition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    appendPermissionDecision: ledgerState.appendPermissionDecision,
    appendToolExecutionBegin: ledgerState.appendToolExecutionBegin,
    appendToolExecutionComplete: ledgerState.appendToolExecutionComplete,
    getSession: () => dbState.session,
    getRecentMessages: () => dbState.recentMessages,
    getDb: () => null,
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn(), retractNeedsInput: vi.fn() },
}));

vi.mock('../../../src/host/services/sessionAutomation/sessionAutomationService', () => ({
  getSessionAutomationService: () => ({ getBySourceRefId: () => null, matchStandingGrant: () => false }),
}));

import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getDenialRegistry } from '../../../src/host/security/denialRegistry';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { bindToolGrantDatabase } from '../../../src/host/permissions/toolGrantStore';
import type { PermissionRequestData, ToolContext } from '../../../src/host/tools/types';
import type { PermissionRequest } from '../../../src/shared/contract';
import type {
  InsertPendingApprovalInput,
  PendingApprovalRepository,
} from '../../../src/host/services/core/repositories/PendingApprovalRepository';

type ProbeCall = (context: ToolContext) => Promise<unknown>;

function installProbe(call: ProbeCall): void {
  resolverState.definition = {
    name: 'probe_tool',
    description: 'in-tool approval session probe',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: false,
    permissionLevel: 'read',
  };
  resolverState.execute.mockImplementation(async (_name: string, _params: unknown, context: ToolContext) => ({
    success: true,
    result: await call(context),
  }));
}

const probeAsk = (context: ToolContext, request: Record<string, unknown>) =>
  context.requestPermission({
    type: 'command',
    tool: 'probe_tool',
    details: {},
    reason: 'probe in-tool approval session attribution',
    ...request,
  } as Parameters<ToolContext['requestPermission']>[0]);

beforeEach(() => {
  bindToolGrantDatabase(null, true);
  resetPermissionModeManager();
  resetDecisionHistory();
  getDenialRegistry().clearAll();
  dbState.session = undefined;
  dbState.recentMessages = [];
  resolverState.definition = undefined;
  resolverState.execute.mockReset();
  Object.values(ledgerState).forEach((f) => f.mockReset());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ToolExecutor in-tool requestPermission session/run id normalisation', () => {
  it('(a) a request without ids is forwarded carrying the execution sessionId (runId is lane-crossing identity, not stamped)', async () => {
    installProbe((context) => probeAsk(context, {}));
    const received: PermissionRequestData[] = [];
    const executor = new ToolExecutor({
      requestPermission: async (request) => { received.push(request); return true; },
      workingDirectory: '/tmp/in-tool-approval-session-a',
      executionTopology: 'async_agent',
    });
    executor.setAuditEnabled(false);
    const result = await executor.execute('probe_tool', {}, { sessionId: 'sess-a', runId: 'run-a' });
    expect(result.success).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ sessionId: 'sess-a', tool: 'probe_tool' });
    // runId 是跨 lane 时由边界盖的「后台 lane」身份；本 lane 自产请求带上它，
    // cron/无人值守自己的停车行会被标 backgroundLane，躲过放弃清理成死卡。
    expect(received[0].runId).toBeUndefined();
  });

  it('(a2) foreground main lane: sessionId is filled but runId stays empty', async () => {
    installProbe((context) => probeAsk(context, {}));
    const received: PermissionRequestData[] = [];
    const executor = new ToolExecutor({
      requestPermission: async (request) => { received.push(request); return true; },
      workingDirectory: '/tmp/in-tool-approval-session-a2',
      executionTopology: 'main',
    });
    executor.setAuditEnabled(false);
    const result = await executor.execute('probe_tool', {}, { sessionId: 'sess-a2', runId: 'run-a2' });
    expect(result.success).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ sessionId: 'sess-a2', tool: 'probe_tool' });
    // runId 是后台 lane 身份：main 请求带上它会被 hasBackgroundRunIdentity 误判
    // （前台 browser_action.upload_file 从当场确认改走停车）。
    expect(received[0].runId).toBeUndefined();
  });

  it('(b) a request that already carries other ids keeps them and its object identity', async () => {
    let sent: PermissionRequestData | undefined;
    installProbe((context) => {
      sent = { type: 'command', tool: 'probe_tool', details: {}, reason: 'probe', sessionId: 'other-sess', runId: 'other-run' };
      return context.requestPermission(sent);
    });
    const received: PermissionRequestData[] = [];
    const executor = new ToolExecutor({
      requestPermission: async (request) => { received.push(request); return true; },
      workingDirectory: '/tmp/in-tool-approval-session-b',
    });
    executor.setAuditEnabled(false);
    const result = await executor.execute('probe_tool', {}, { sessionId: 'sess-b', runId: 'run-b' });
    expect(result.success).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ sessionId: 'other-sess', runId: 'other-run' });
    // permissionAskResults 是 WeakMap：同一个对象引用必须原样透传，shadowAdapter 才能回查。
    expect(received[0]).toBe(sent);
  });

  it('(c) the denial registry and the permission ledger still see the same session id', async () => {
    installProbe((context) => probeAsk(context, {}));
    const observe = vi.spyOn(getDenialRegistry(), 'observeApproval');
    const executor = new ToolExecutor({
      requestPermission: async () => ({ approved: true, approvalSource: 'user' }),
      workingDirectory: '/tmp/in-tool-approval-session-c',
    });
    executor.setAuditEnabled(false);
    const result = await executor.execute('probe_tool', {}, { sessionId: 'sess-c', runId: 'run-c' });
    expect(result.success).toBe(true);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-c', runId: 'run-c' }));
    const rows = ledgerState.appendPermissionDecision.mock.calls.map(([e]) => e as Record<string, unknown>);
    expect(rows).toEqual([expect.objectContaining({ sessionId: 'sess-c', toolName: 'probe_tool', historyOutcome: 'ask-approved' })]);
  });

  it('(d) an execution without session/run id forwards the request object unchanged', async () => {
    let sent: PermissionRequestData | undefined;
    installProbe((context) => {
      sent = { type: 'command', tool: 'probe_tool', details: {}, reason: 'probe' };
      return context.requestPermission(sent);
    });
    const received: PermissionRequestData[] = [];
    const executor = new ToolExecutor({
      requestPermission: async (request) => { received.push(request); return true; },
      workingDirectory: '/tmp/in-tool-approval-session-d',
    });
    executor.setAuditEnabled(false);
    const result = await executor.execute('probe_tool', {}, {});
    expect(result.success).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBeUndefined();
    expect(received[0].runId).toBeUndefined();
    expect(received[0]).toBe(sent);
  });
});

describe('chain: in-tool approval reaches OrchestratorPermissionIsland with session id', () => {
  const settings = () => ({
    permissions: { autoApprove: { read: false, write: false, execute: false, network: false } },
  });

  it('unattended session: the parked pending_approvals payload carries a non-empty sessionId', async () => {
    const sessionId = 'chain-unattended-session';
    getPermissionModeManager().markUnattendedSession(sessionId);
    dbState.session = { title: 'nightly job', origin: { kind: 'cron' } };
    const inserted: InsertPendingApprovalInput[] = [];
    const repo = {
      insert: (input: InsertPendingApprovalInput) => { inserted.push(input); },
      resolve: () => 1,
    } as unknown as PendingApprovalRepository;
    const cards: PermissionRequest[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: settings as never,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      injectedPendingApprovalRepo: repo,
      onEvent: (event) => {
        if (event.type !== 'permission_request' || event.data.resolved) return;
        cards.push(event.data as PermissionRequest);
        island.resolveParkedApproval((event.data as PermissionRequest).id, 'deny');
      },
    });
    installProbe((context) => probeAsk(context, {}));
    const executor = new ToolExecutor({
      requestPermission: (request) => island.requestPermission(request),
      workingDirectory: '/tmp/in-tool-approval-chain-unattended',
      executionTopology: 'async_agent',
    });
    executor.setAuditEnabled(false);
    const result = await executor.execute('probe_tool', {}, { sessionId, runId: 'run-chain-1' });
    expect(result.success).toBe(true);
    expect(inserted).toHaveLength(1);
    const payload = inserted[0].payload as { sessionId?: string | null; backgroundLane?: boolean };
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.sessionId).toBeTruthy();
    expect(inserted[0].coordinatorId).toBe(sessionId);
    // 本 lane 自产请求没有 run 身份：停车行不带 backgroundLane，
    // 放弃已恢复 waiting run 时 rejectAbandonedSessionApprovals 才能正常作废它（不留死卡）。
    expect(payload.backgroundLane).toBeUndefined();
  });

  it('attended session with a user message: the card quotes details.userRequest', async () => {
    const sessionId = 'chain-attended-session';
    const userWords = 'open example.com in the browser and fill the contact form with my name';
    dbState.session = { title: 'attended chat' };
    dbState.recentMessages = [{ role: 'user', content: userWords, isMeta: false }];
    const repo = {
      insert: vi.fn(),
      resolve: () => 1,
    } as unknown as PendingApprovalRepository;
    const cards: PermissionRequest[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: settings as never,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => true,
      injectedPendingApprovalRepo: repo,
      onEvent: (event) => {
        if (event.type !== 'permission_request' || event.data.resolved) return;
        cards.push(event.data as PermissionRequest);
        island.handlePermissionResponse((event.data as PermissionRequest).id, 'deny');
      },
    });
    installProbe((context) => probeAsk(context, {}));
    const executor = new ToolExecutor({
      requestPermission: (request) => island.requestPermission(request),
      workingDirectory: '/tmp/in-tool-approval-chain-attended',
    });
    executor.setAuditEnabled(false);
    const result = await executor.execute('probe_tool', {}, { sessionId, runId: 'run-chain-2' });
    expect(result.success).toBe(true);
    expect(cards).toHaveLength(1);
    expect(cards[0].sessionId).toBe(sessionId);
    expect(cards[0].runId).toBeUndefined();
    expect(cards[0].details?.userRequest).toEqual({ text: userWords, truncated: false });
    expect(repo.insert as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('foreground main session: browser_action.upload_file forceConfirm stays interactive, never parked', async () => {
    const sessionId = 'chain-foreground-upload';
    dbState.session = { title: 'foreground chat' };
    dbState.recentMessages = [{ role: 'user', content: 'upload the receipt photo to the form', isMeta: false }];
    const insert = vi.fn();
    const repo = { insert, resolve: () => 1 } as unknown as PendingApprovalRepository;
    const cards: PermissionRequest[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: settings as never,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => true,
      injectedPendingApprovalRepo: repo,
      onEvent: (event) => {
        if (event.type !== 'permission_request' || event.data.resolved) return;
        cards.push(event.data as PermissionRequest);
        island.handlePermissionResponse((event.data as PermissionRequest).id, 'allow');
      },
    });
    installProbe((context) =>
      context.requestPermission({
        type: 'file_read',
        tool: 'browser_action.upload_file',
        forceConfirm: true,
        details: { action: 'upload_file' },
        reason: 'probe foreground upload confirm',
      } as Parameters<ToolContext['requestPermission']>[0]));
    const executor = new ToolExecutor({
      requestPermission: (request) => island.requestPermission(request),
      workingDirectory: '/tmp/in-tool-approval-chain-fg-upload',
    });
    executor.setAuditEnabled(false);
    const result = await executor.execute('probe_tool', {}, { sessionId, runId: 'run-foreground-1' });
    expect(result.success).toBe(true);
    // 前台 upload_file 是当场确认：带上 runId 会被 backgroundExactFile 改判停车，
    // 横幅指向「自动化→运行记录」（只收 cron/heartbeat），请求挂到 24h 兜底才拒。
    expect(insert).not.toHaveBeenCalled();
    expect(cards).toHaveLength(1);
    expect(cards[0].sessionId).toBe(sessionId);
    expect(cards[0].runId).toBeUndefined();
  });
});
