// 日历改 / 删的目标日程找不到时，不弹审批卡，直接把「请 list_events 重查」还给模型。
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
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { useDarwinPlatform } from '../connectors/fakeCalendarBridge';

useDarwinPlatform();
const HOUR = 3_600_000;
const TOOLS = ['calendar_delete_event', 'calendar_update_event'] as const;

function makeExecutor() {
  const requestPermission = vi.fn().mockResolvedValue({ approved: true, approvalSource: 'user' });
  return { requestPermission, executor: new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' }) };
}
const askRows = () => ledgerState.appendPermissionDecision.mock.calls
  .map(([e]) => e as Record<string, unknown>)
  .filter((e) => e.historyOutcome === 'ask-approved' || e.historyOutcome === 'ask-denied');

beforeEach(() => {
  resetDecisionHistory();
  fake.reset();
  fake.state.calendars = [{ id: 'cal-id-8012', title: '日历', writable: true, isDefault: true }];
  resetCalendarConnectorReadiness();
  for (const m of [resolverState.getDefinition, resolverState.execute, ...Object.values(ledgerState)]) m.mockReset();
  resolverState.getDefinition.mockImplementation((name: string) => ({
    name, description: name, inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: true, permissionLevel: 'write',
  }));
  resolverState.execute.mockResolvedValue({ success: true, result: 'ran' });
});

describe('ToolExecutor: calendar delete/update with an unresolvable event', () => {
  it.each(TOOLS)('① ② %s with a title as event_uid: no approval card, no ledger row, model told to list_events', async (tool) => {
    const { requestPermission, executor } = makeExecutor();
    const result = await executor.execute(tool, { calendar: '日历', event_uid: 'Quarterly review', start_ms: HOUR }, { sessionId: `s-${tool}` });
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(askRows()).toEqual([]);
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('list_events');
    expect(result.metadata).toMatchObject({ code: 'CALENDAR_EVENT_NOT_FOUND' });
  });

  it.each(TOOLS)('③ %s with a found event still asks exactly once with title/time/calendar/location', async (tool) => {
    fake.state.items.push({ id: 'cal-id-8012:EV1', calendarId: 'cal-id-8012', calendar: '日历', title: '评审', startMs: HOUR, endMs: 2 * HOUR, location: '三楼' });
    const { requestPermission, executor } = makeExecutor();
    const params = tool === 'calendar_delete_event'
      ? { calendar: '日历', event_uid: 'cal-id-8012:EV1' }
      : { calendar: '日历', event_uid: 'cal-id-8012:EV1', title: '新标题' };
    await executor.execute(tool, params, { sessionId: `s-found-${tool}` });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const details = requestPermission.mock.calls[0][0].details;
    if (tool === 'calendar_delete_event') {
      expect(details).toMatchObject({ calendar: '日历', title: '评审', start_ms: HOUR, end_ms: 2 * HOUR, location: '三楼' });
    } else {
      expect(details).toMatchObject({ calendar: '日历', title: '新标题', start_ms: HOUR, end_ms: 2 * HOUR, location: '三楼',
        calendarApprovalSnapshotFields: ['start_ms', 'end_ms', 'location'] });
    }
  });

  it.each(TOOLS)('④ %s not authorized + unknown uid still reaches the card, and grants nothing', async (tool) => {
    fake.state.status = 2;
    const { requestPermission, executor } = makeExecutor();
    await executor.execute(tool, { calendar: '日历', event_uid: 'Quarterly review', start_ms: HOUR }, { sessionId: `s-na-${tool}` });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details).not.toHaveProperty('title');
    expect(fake.state.grants).toBe(0);
  });
});
