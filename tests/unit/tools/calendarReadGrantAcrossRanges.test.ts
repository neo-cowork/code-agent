// FB-2424 回归钉：读日程的「本次任务内允许」跨日期范围只问一次。
// grant key = connectorToolGrantIdentity('calendar', null) = { tool: 'calendar', target: null }，
// 不含日期范围：today 弹卡批了 allow_run 后，查 tomorrow 命中同一份授权，不再弹卡；
// 反向保证（reverse）：calendar_create_event / calendar_delete_event 是独立工具，
// 读授权不放行写回——照常弹一次卡，且写回卡上的 allow_run 不铸造任何授权。
// 生产入口：ToolExecutor.execute → toolResolver（mock 只做分发，落到真实 ToolModule 与
// buildCanUseToolFromLegacy）→ ToolExecutor 体内 requestPermission 包装器（授权消费 + 记账）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({ getDefinition: vi.fn(), execute: vi.fn() }));
const ledger = vi.hoisted(() => ({ appendPermissionDecision: vi.fn(), appendToolExecutionBegin: vi.fn(), appendToolExecutionComplete: vi.fn() }));
const connectorExecute = vi.hoisted(() => vi.fn());
const connectorGet = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({ getDefinition: resolverState.getDefinition, execute: resolverState.execute }),
}));
vi.mock('../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({ get: connectorGet }),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: () => ledger }));
vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({ createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));
// LogCollector 单例在模块加载时启用文件持久化（mcpServer 传递依赖），测试里不需要
vi.mock('../../../src/host/mcp/logCollector', () => ({
  logCollector: { addLog: vi.fn(), getLogs: () => [], getAllLogs: () => [] },
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn(), retractNeedsInput: vi.fn() },
}));
vi.mock('../../../src/host/services/sessionAutomation/sessionAutomationService', () => ({
  getSessionAutomationService: () => ({ matchStandingGrant: () => false }),
}));

import type { PermissionRequest } from '../../../src/shared/contract';
import { DEFAULT_SETTINGS } from '../../../src/host/services/core/configDefaults';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { connectorToolGrantIdentity } from '../../../src/host/permissions/connectorToolAccess';
import { resolvePreAskGrant } from '../../../src/host/permissions/preAskGrant';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { bindToolGrantDatabase, listToolGrants, mintToolRunGrant } from '../../../src/host/permissions/toolGrantStore';
import { buildCanUseToolFromLegacy, buildProtocolContext } from '../../../src/host/tools/dispatch/shadowAdapter';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData, ToolContext, ToolExecutionResult } from '../../../src/host/tools/types';
import type { ToolModule } from '../../../src/host/protocol/tools';
import { calendarModule } from '../../../src/host/tools/modules/connectors/calendar';
import { calendarCreateEventModule } from '../../../src/host/tools/modules/connectors/calendarCreateEvent';
import { calendarDeleteEventModule } from '../../../src/host/tools/modules/connectors/calendarDeleteEvent';

// 真实 ToolModule 分发表：resolver mock 只做名字分发，权限链全部走生产代码。
const REAL_MODULES: Record<string, ToolModule<Record<string, unknown>, string>> = {
  calendar: calendarModule,
  calendar_create_event: calendarCreateEventModule,
  calendar_delete_event: calendarDeleteEventModule,
};

// 与生产 getToolDefinition 派生一致（requiresPermission ?? permissionLevel !== 'read'）：
// calendar 读 = 不问外层闸（工具体内 canUseTool 是唯一一问）；写回 = 外层权限闸问。
const DEFINITIONS: Record<string, Record<string, unknown>> = {
  calendar: {
    name: 'calendar',
    description: 'read calendar',
    permissionLevel: 'read',
    readOnly: true,
    requiresPermission: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get_status', 'list_calendars', 'list_events'] },
        calendar: { type: 'string' },
        from_local: { type: 'string' },
        to_local: { type: 'string' },
        from_ms: { type: 'number' },
        to_ms: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['action'],
    },
  },
  calendar_create_event: {
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
        start_local: { type: 'string' },
        end_local: { type: 'string' },
        start_ms: { type: 'number' },
        end_ms: { type: 'number' },
        location: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['title'],
    },
  },
  calendar_delete_event: {
    name: 'calendar_delete_event',
    description: 'delete calendar event',
    permissionLevel: 'write',
    readOnly: false,
    requiresPermission: true,
    inputSchema: {
      type: 'object',
      properties: {
        calendar: { type: 'string' },
        event_uid: { type: 'string' },
      },
      required: ['calendar', 'event_uid'],
    },
  },
};

const EVENT_START_MS = Date.parse('2026-11-21T09:30:00');

/**
 * 交互审批岛：每张卡记进 events 并用 queueMicrotask 自动应答 allow_run，
 * 铸权走真实 recordHumanGrant（OrchestratorPermissionIsland 的交互裁决口）。
 */
function makeApprovalIsland(): { island: OrchestratorPermissionIsland; events: PermissionRequest[] } {
  const events: PermissionRequest[] = [];
  const island = new OrchestratorPermissionIsland({
    getSettings: () => ({
      ...DEFAULT_SETTINGS,
      permissions: { ...DEFAULT_SETTINGS.permissions, autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [] },
    }),
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'main',
    hasApprovalUi: () => true,
    onEvent: (event) => {
      if (event.type === 'permission_request') {
        const data = event.data as PermissionRequest;
        events.push(data);
        queueMicrotask(() => { island.handlePermissionResponse(data.id, 'allow_run'); });
      }
    },
  });
  return { island, events };
}

function makeExecutor(island: OrchestratorPermissionIsland): { executor: ToolExecutor; ask: ReturnType<typeof vi.fn> } {
  const ask = vi.fn((request: PermissionRequestData) =>
    island.requestPermission(request as unknown as PermissionRequest));
  return { executor: new ToolExecutor({ requestPermission: ask, workingDirectory: '/tmp/wb' }), ask };
}

function permissionAskRows(): Array<Record<string, unknown>> {
  return ledger.appendPermissionDecision.mock.calls
    .map(([row]) => row as Record<string, unknown>)
    .filter((row) => row.historyOutcome === 'ask-approved' || row.historyOutcome === 'ask-denied');
}

beforeEach(() => {
  bindToolGrantDatabase(null, true);
  resetPermissionModeManager();
  Object.values(ledger).forEach((f) => f.mockReset());
  resolverState.getDefinition.mockImplementation((name: string) => DEFINITIONS[name]);
  resolverState.execute.mockImplementation(async (
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> => {
    const module = REAL_MODULES[name];
    if (!module) return { success: false, error: `tool not registered: ${name}` };
    const protoCtx = buildProtocolContext({
      sessionId: ctx.sessionId,
      workingDirectory: ctx.workingDirectory,
      legacyCtx: ctx,
      abortSignal: ctx.abortSignal,
    });
    const handler = module.createHandler();
    const protoResult = await handler.execute(args, protoCtx, buildCanUseToolFromLegacy(ctx, name));
    if (protoResult.ok) {
      return { success: true, output: protoResult.output, result: protoResult.output, metadata: protoResult.meta };
    }
    return { success: false, error: protoResult.error, metadata: { code: protoResult.code, ...(protoResult.meta ?? {}) } };
  });
  connectorGet.mockReset();
  connectorGet.mockReturnValue({ execute: connectorExecute });
  connectorExecute.mockReset();
  connectorExecute.mockImplementation(async (action: string, args: Record<string, unknown>) => {
    if (action === 'get_event') {
      return { data: { uid: 'evt-1', calendar: 'Home', title: '已有日程', startAtMs: EVENT_START_MS, endAtMs: EVENT_START_MS + 30 * 60_000 } };
    }
    if (action === 'create_event') {
      return { data: { uid: 'evt-new', calendar: String(args.calendar), title: String(args.title), startAtMs: EVENT_START_MS, endAtMs: EVENT_START_MS + 30 * 60_000 } };
    }
    if (action === 'delete_event') {
      return { data: { uid: String(args.event_uid), calendar: String(args.calendar), title: '已有日程', deleted: true } };
    }
    if (action === 'default_calendar') return { data: 'Home' };
    return { data: [] };
  });
});

afterEach(() => {
  bindToolGrantDatabase(null, true);
  resetPermissionModeManager();
});

describe('读日程授权跨日期范围只问一次（FB-2424）', () => {
  it('today 批了 allow_run 之后查 tomorrow：不再弹卡，两次都成功，共 1 次询问', async () => {
    const { island, events } = makeApprovalIsland();
    const { executor, ask } = makeExecutor(island);
    const today = await executor.execute(
      'calendar',
      { action: 'list_events', from_local: '2026-11-21 00:00', to_local: '2026-11-21 23:59' },
      { sessionId: 'sess-a' },
    );
    const tomorrow = await executor.execute(
      'calendar',
      { action: 'list_events', from_local: '2026-11-22 00:00', to_local: '2026-11-22 23:59' },
      { sessionId: 'sess-a' },
    );
    expect(today.success).toBe(true);
    expect(tomorrow.success).toBe(true);
    // 两次调用都是真实 executeCalendar 跑出来的空结果输出
    expect(String(today.result)).toContain('没有找到匹配的日历事件。');
    expect(String(tomorrow.result)).toContain('没有找到匹配的日历事件。');
    // 第一通弹卡、第二通授权命中：总共只问 1 次
    expect(ask).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('calendar');
    // 账本：第一次是真人批（reason 'user'），第二次是授权命中（toolExecutor 体内包装器记 session-allowlist）
    const rows = permissionAskRows().filter((row) => row.toolName === 'calendar');
    expect(rows.map((row) => row.reason)).toEqual(['user', 'session-allowlist']);
    expect(rows[1]).toMatchObject({ historyOutcome: 'ask-approved', reason: 'session-allowlist', toolName: 'calendar' });
  });

  it('授权按任务隔离：别的 sessionId 拿同一份授权仍要问', async () => {
    const { island, events } = makeApprovalIsland();
    const { executor, ask } = makeExecutor(island);
    mintToolRunGrant('sess-a', 'calendar', null);
    const result = await executor.execute(
      'calendar',
      { action: 'list_events', from_local: '2026-11-21 00:00', to_local: '2026-11-21 23:59' },
      { sessionId: 'sess-b' },
    );
    expect(result.success).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });
});

describe('读授权不放行写回（reverse）', () => {
  it('带着 calendar 读授权调 calendar_create_event：仍弹一次卡，且不铸造任何授权', async () => {
    const { island, events } = makeApprovalIsland();
    const { executor, ask } = makeExecutor(island);
    mintToolRunGrant('sess-a', 'calendar', null);
    const result = await executor.execute(
      'calendar_create_event',
      { calendar: 'Home', title: '写回回归检查', start_local: '2026-11-21 09:30' },
      { sessionId: 'sess-a' },
    );
    expect(result.success).toBe(true);
    // 没有被读授权静默放行：照常弹卡
    expect(ask).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('calendar_create_event');
    // 卡是真人批的（reason 'user'），不是 session-allowlist
    const rows = permissionAskRows().filter((row) => row.toolName === 'calendar_create_event');
    expect(rows.map((row) => row.reason)).toEqual(['user']);
    // 写回卡上的 allow_run 不铸造任何 run/24h 授权（isEditableTool 拒铸）：
    // 授权库仍然只有测试前置的那一份 calendar 读授权，没有新增行
    expect(listToolGrants()).toEqual([
      expect.objectContaining({ tool: 'calendar', target: null, tier: 'run', sessionId: 'sess-a' }),
    ]);
  });

  it('带着 calendar 读授权调 calendar_delete_event：仍弹一次卡', async () => {
    const { island, events } = makeApprovalIsland();
    const { executor, ask } = makeExecutor(island);
    mintToolRunGrant('sess-a', 'calendar', null);
    const result = await executor.execute(
      'calendar_delete_event',
      { calendar: 'Home', event_uid: 'evt-1' },
      { sessionId: 'sess-a' },
    );
    expect(result.success).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('calendar_delete_event');
    const rows = permissionAskRows().filter((row) => row.toolName === 'calendar_delete_event');
    expect(rows.map((row) => row.reason)).toEqual(['user']);
  });

  it('授权键反向钉：calendar_* 写回的授权身份是写回工具本身，读授权在授权查找层命中不了', () => {
    // 铸权与消费共用 connectorToolGrantIdentity：写回的 key 若被并进 calendar 读 key，
    // 读授权就会在授权查找层放行写回。写回走 ToolExecutor 外层闸时这一层被 C1
    // trustBoundary 挡在前面（外层 preAsk blocked），所以在这里直接钉授权键本身。
    expect(connectorToolGrantIdentity('calendar_create_event', null)).toEqual({ tool: 'calendar_create_event', target: null });
    expect(connectorToolGrantIdentity('calendar_delete_event', null)).toEqual({ tool: 'calendar_delete_event', target: null });
    expect(connectorToolGrantIdentity('calendar_update_event', null)).toEqual({ tool: 'calendar_update_event', target: null });
    mintToolRunGrant('sess-a', 'calendar', null);
    // 同会话的 calendar 读授权，对写回工具的 preAsk 授权查找不命中
    for (const tool of ['calendar_create_event', 'calendar_update_event', 'calendar_delete_event']) {
      expect(resolvePreAskGrant({ toolName: tool, sessionId: 'sess-a', standingGrantTarget: null, computerApp: null, blocked: false })).toBeNull();
    }
  });
});
