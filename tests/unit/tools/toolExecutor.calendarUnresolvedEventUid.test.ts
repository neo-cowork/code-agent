// 日历改 / 删传了 uid 形态但查无此日程（或查无此日历名）时：不弹审批卡、假桥上无写调用、
// 日历条目原样，结果直接让模型重新 list_events。能删 / 能改的那条 uid 不是测试塞的，
// 是经同一条 ToolExecutor.execute 跑真 calendar 模块的 list_events 拿回来的（模型自我纠错的另一半）。
// 走生产入口 ToolExecutor.execute + 真日历连接器 + 假 EventKit 桥。Evidence class: hermetic-protocol.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fake } = await vi.hoisted(async () => ({ fake: (await import('../connectors/fakeCalendarBridge')).createFakeCalendarBridge() }));
vi.mock('../../../src/host/permissions/envAssist/shellBridge/client', async (orig) => ({
  ...(await orig<object>()), resolveShellBridgeClientFromEnv: () => fake.client,
}));
vi.mock('../../../src/host/connectors', async (orig) => {
  const { calendarConnector } = await import('../../../src/host/connectors/native/calendar');
  return { ...(await orig<object>()), getConnectorRegistry: () => ({ get: (id: string) => (id === 'calendar' ? calendarConnector : undefined) }) };
});
const resolverState = vi.hoisted(() => ({ getDefinition: vi.fn(), execute: vi.fn() }));
const ledgerState = vi.hoisted(() => ({
  appendPermissionDecision: vi.fn(), appendToolExecutionBegin: vi.fn(), appendToolExecutionComplete: vi.fn(),
}));
vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({ getDefinition: resolverState.getDefinition, execute: resolverState.execute }),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ledgerState,
}));
vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { resetCalendarConnectorReadiness } from '../../../src/host/connectors/native/calendar';
import { buildProtocolContext } from '../../../src/host/tools/dispatch/shadowAdapter';
import { calendarModule } from '../../../src/host/tools/modules/connectors/calendar';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { ToolContext, ToolExecutionResult } from '../../../src/host/tools/types';
import type { CanUseToolFn } from '../../../src/host/protocol/tools';
import { useDarwinPlatform } from '../connectors/fakeCalendarBridge';

useDarwinPlatform();
const HOUR = 3_600_000;
const TOOLS = ['calendar_delete_event', 'calendar_update_event'] as const;
const WRITE_PATH = '/v1/write/calendar-event';
const LIST_PARAMS = { action: 'list_events', calendar: '日历', from_ms: 0, to_ms: 100 * HOUR };
const SEEDED = { id: 'cal-id-8012:EV9', calendarId: 'cal-id-8012', calendar: '日历', title: '评审', startMs: HOUR, endMs: 2 * HOUR, location: '三楼' };

function makeExecutor() {
  const requestPermission = vi.fn().mockResolvedValue({ approved: true, approvalSource: 'user' });
  return { requestPermission, executor: new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' }) };
}
const askRows = () => ledgerState.appendPermissionDecision.mock.calls
  .map(([e]) => e as Record<string, unknown>)
  .filter((e) => e.historyOutcome === 'ask-approved' || e.historyOutcome === 'ask-denied');

const missParams = (tool: string, calendar: string) => (tool === 'calendar_delete_event'
  ? { calendar, event_uid: 'evt-99999-nonexistent' }
  : { calendar, event_uid: 'evt-99999-nonexistent', title: '改名' });

const foundParams = (tool: string, uid: string) => (tool === 'calendar_delete_event'
  ? { calendar: '日历', event_uid: uid }
  // 只改地点：title/start_ms/end_ms 留在卡上是既有日程的快照值，不是提议写值。
  : { calendar: '日历', event_uid: uid, location: '新地点' });

async function listEventUid(executor: ToolExecutor, sessionId: string): Promise<string> {
  const list = await executor.execute('calendar', { ...LIST_PARAMS }, { sessionId });
  expect(list.success).toBe(true);
  const events = (list.metadata?.events ?? []) as Array<{ uid?: string }>;
  expect(events.map((e) => e.uid)).toEqual([SEEDED.id]);
  return events[0].uid as string;
}

beforeEach(() => {
  resetDecisionHistory();
  fake.reset();
  fake.state.calendars = [{ id: 'cal-id-8012', title: '日历', writable: true, isDefault: true }];
  resetCalendarConnectorReadiness();
  for (const m of [resolverState.getDefinition, resolverState.execute, ...Object.values(ledgerState)]) m.mockReset();
  resolverState.getDefinition.mockImplementation((name: string) => {
    const read = name === 'calendar';
    return {
      name, description: name, inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: !read, permissionLevel: read ? 'read' : 'write',
      ...(read ? { readOnly: true } : {}),
    };
  });
  resolverState.execute.mockImplementation(async (
    name: string, args: Record<string, unknown>, ctx: ToolContext,
  ): Promise<ToolExecutionResult> => {
    // 读工具走真 calendar 模块（window 归一化 + 连接器 + 输出格式化），写工具照常替身：
    // 要验证的是审批卡那一层，不是工具体内逻辑。
    if (name !== 'calendar') return { success: true, result: 'ran' };
    const protoCtx = buildProtocolContext({
      sessionId: ctx.sessionId, workingDirectory: ctx.workingDirectory, legacyCtx: ctx, abortSignal: ctx.abortSignal,
    });
    const allowAll: CanUseToolFn = async () => ({ allow: true });
    const protoResult = await (await calendarModule.createHandler()).execute(args, protoCtx, allowAll);
    if (!protoResult.ok) return { success: false, error: protoResult.error, metadata: { code: protoResult.code } };
    const output = typeof protoResult.output === 'string' ? protoResult.output : JSON.stringify(protoResult.output);
    return { success: true, output, result: protoResult.output, metadata: protoResult.meta };
  });
});

describe('ToolExecutor: calendar delete/update with a uid-shaped but unresolvable event', () => {
  it.each(TOOLS)('① %s with uid evt-99999-nonexistent: no card, no write on the bridge, items unchanged', async (tool) => {
    fake.state.items.push({ ...SEEDED });
    const itemsBefore = structuredClone(fake.state.items);
    const { requestPermission, executor } = makeExecutor();
    const result = await executor.execute(tool, missParams(tool, '日历'), { sessionId: `s-miss-${tool}` });
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(askRows()).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('list_events');
    expect(result.metadata).toMatchObject({ code: 'CALENDAR_EVENT_NOT_FOUND' });
    expect(fake.state.items).toEqual(itemsBefore);
    expect(fake.paths()).not.toContain(WRITE_PATH);
  });

  it.each(TOOLS)('① %s with a non-existent calendar name: same no-card outcome', async (tool) => {
    fake.state.items.push({ ...SEEDED });
    const itemsBefore = structuredClone(fake.state.items);
    const { requestPermission, executor } = makeExecutor();
    const result = await executor.execute(tool, missParams(tool, '不存在的日历'), { sessionId: `s-misscal-${tool}` });
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(askRows()).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('list_events');
    expect(result.metadata).toMatchObject({ code: 'CALENDAR_EVENT_NOT_FOUND' });
    expect(fake.state.items).toEqual(itemsBefore);
    expect(fake.paths()).not.toContain(WRITE_PATH);
  });

  it.each(TOOLS)('② %s with a uid from list_events asks exactly once with the seeded title/start/end', async (tool) => {
    fake.state.items.push({ ...SEEDED });
    const { requestPermission, executor } = makeExecutor();
    const uid = await listEventUid(executor, `s-list-${tool}`);
    const result = await executor.execute(tool, foundParams(tool, uid), { sessionId: `s-found-${tool}` });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details).toMatchObject({ title: '评审', start_ms: HOUR, end_ms: 2 * HOUR });
    expect(result.success).toBe(true);
  });

  it.each(TOOLS)('③ %s model self-corrects: fake uid then list_events uid in one session → exactly 1 card', async (tool) => {
    fake.state.items.push({ ...SEEDED });
    const { requestPermission, executor } = makeExecutor();
    const sessionId = `s-seq-${tool}`;
    const miss = await executor.execute(tool, missParams(tool, '日历'), { sessionId });
    expect(miss.success).toBe(false);
    expect(miss.metadata).toMatchObject({ code: 'CALENDAR_EVENT_NOT_FOUND' });
    const uid = await listEventUid(executor, sessionId);
    const hit = await executor.execute(tool, foundParams(tool, uid), { sessionId });
    expect(hit.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details).toMatchObject({ title: '评审', start_ms: HOUR, end_ms: 2 * HOUR });
  });
});
