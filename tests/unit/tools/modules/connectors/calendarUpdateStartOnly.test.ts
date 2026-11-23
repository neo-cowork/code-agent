// 用户只说「把周会挪到下午 4 点」→ 模型只发 start_local、不发 end。真机两批都没走到这个分支，
// 这里用真 ToolExecutor + 真工具模块 + 真日历连接器 + 假原生桥（照 Rust resolve_update_range）
// 端到端钉死：start-only 改期保住时长（end 跟着 start 走），批准卡绝不投影旧 end。
// Evidence class: hermetic-protocol（Rust 侧由 resolve_update_range_start_only_keeps_duration 覆盖）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fake } = await vi.hoisted(async () => ({ fake: (await import('../../../connectors/fakeCalendarBridge')).createFakeCalendarBridge() }));
vi.mock('../../../../../src/host/permissions/envAssist/shellBridge/client', async (orig) => ({
  ...(await orig<object>()), resolveShellBridgeClientFromEnv: () => fake.client,
}));
vi.mock('../../../../../src/host/connectors', async (orig) => {
  const { calendarConnector } = await import('../../../../../src/host/connectors/native/calendar');
  return { ...(await orig<object>()), getConnectorRegistry: () => ({ get: (id: string) => (id === 'calendar' ? calendarConnector : undefined) }) };
});

const mocks = vi.hoisted(() => ({
  getSchemas: vi.fn(),
  has: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../../../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: () => ({
    getSchemas: mocks.getSchemas,
    has: mocks.has,
    resolve: mocks.resolve,
  }),
  isProtocolToolName: vi.fn(() => false),
  resetProtocolRegistry: vi.fn(),
}));

vi.mock('../../../../../src/host/tools/protocolToolRegistration', () => ({
  getProtocolToolSchemas: mocks.getSchemas,
  hasProtocolTool: mocks.has,
  resolveProtocolTool: mocks.resolve,
  registerProtocolTool: vi.fn(),
  unregisterProtocolTool: vi.fn(),
  setProtocolToolRegistryPort: vi.fn(),
}));

vi.mock('../../../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({
    getAllToolMeta: () => ({}),
  }),
}));

vi.mock('../../../../../src/host/mcp', () => ({
  getMCPClient: () => ({
    getToolDefinitions: () => [],
    parseMCPToolName: () => null,
  }),
}));

vi.mock('../../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
    invalidateForPath: vi.fn(),
    invalidateForWorkspace: vi.fn(),
  }),
}));

vi.mock('../../../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../../../src/host/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { calendarUpdateEventModule } from '../../../../../src/host/tools/modules/connectors/calendarUpdateEvent';
import { resetCalendarConnectorReadiness } from '../../../../../src/host/connectors/native/calendar';
import type { PermissionRequestData } from '../../../../../src/host/tools/types';
import { useDarwinPlatform } from '../../../connectors/fakeCalendarBridge';
const { ToolExecutor } = await import('../../../../../src/host/tools/toolExecutor');
const { resetToolResolver } = await import('../../../../../src/host/tools/dispatch/toolResolver');

useDarwinPlatform();
const modules = [calendarUpdateEventModule];
let session = 0;

function executor(requestPermission: ConstructorParameters<typeof ToolExecutor>[0]['requestPermission']) {
  const instance = new ToolExecutor({ workingDirectory: process.cwd(), requestPermission, forcePermissionHandler: true });
  instance.setAuditEnabled(false);
  return instance;
}

beforeEach(() => {
  resetToolResolver();
  mocks.getSchemas.mockReturnValue(modules.map((m) => m.schema));
  mocks.has.mockImplementation((name: string) => modules.some((m) => m.schema.name === name));
  mocks.resolve.mockImplementation((name: string) => modules.find((m) => m.schema.name === name)?.createHandler());
  fake.reset();
  resetCalendarConnectorReadiness();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('calendar_update_event with only start_local through ToolExecutor.execute', () => {
  it.each([
    ['a later start past the old end', '2026-11-20 16:00', '2026-11-20T16:00:00+08:00', '2026-11-20T17:00:00+08:00'],
    ['an earlier start', '2026-11-20 08:00', '2026-11-20T08:00:00+08:00', '2026-11-20T09:00:00+08:00'],
    ['a start inside the old range', '2026-11-20 10:30', '2026-11-20T10:30:00+08:00', '2026-11-20T11:30:00+08:00'],
  ])('%s on a 10:00-11:00 event: keeps the 1 h duration, writes no endMs, and the card shows no stale end', async (_name, startLocal, startIso, endIso) => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(endIso);
    const oldStart = Date.parse('2026-11-20T10:00:00+08:00');
    const oldEnd = Date.parse('2026-11-20T11:00:00+08:00');
    fake.state.items.push({ id: 'e1', calendarId: 'c-work', calendar: 'Work', title: '周会', startMs: oldStart, endMs: oldEnd });

    let cardDetails: Record<string, unknown> | undefined;
    const requestPermission = vi.fn(async (request: PermissionRequestData) => {
      cardDetails = request.details;
      return true;
    });
    const result = await executor(requestPermission).execute(
      'calendar_update_event',
      { calendar: 'Work', event_uid: 'e1', start_local: startLocal },
      { sessionId: `cal-start-only-${++session}` },
    );

    expect(result).toMatchObject({ success: true });
    expect(JSON.stringify(result)).not.toContain('event_end_not_after_start');
    expect(requestPermission).toHaveBeenCalledOnce();

    // 批准卡：新 start 的 ms，绝不带旧 end / 本地串。
    expect(cardDetails).toMatchObject({ calendar: 'Work', event_uid: 'e1', start_ms: startMs });
    expect(cardDetails).not.toHaveProperty('end_ms');
    expect(cardDetails).not.toHaveProperty('start_local');
    expect(cardDetails).not.toHaveProperty('end_local');

    // 写体只带 startMs；原生层（假桥照 Rust）把 end 挪成 start + 原时长。
    const write = fake.state.calls.find((c) => c.path === '/v1/write/calendar-event');
    console.log(`[calendarUpdateStartOnly] ${_name} write body:`, JSON.stringify(write?.body));
    expect(write?.body).toMatchObject({ op: 'update', eventId: 'e1', startMs });
    expect(write?.body).not.toHaveProperty('endMs');

    expect(fake.state.items[0]).toMatchObject({ startMs, endMs });
    expect(result.metadata).toMatchObject({ startAtMs: startMs, endAtMs: endMs });
  });
});
