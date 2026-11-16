import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectorExecute: vi.fn(),
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


vi.mock('../../../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({ get: () => ({ execute: mocks.connectorExecute }) }),
}));

import { calendarCreateEventModule } from '../../../../../src/host/tools/modules/connectors/calendarCreateEvent';
import { calendarUpdateEventModule } from '../../../../../src/host/tools/modules/connectors/calendarUpdateEvent';
import type { PermissionRequestData } from '../../../../../src/host/tools/types';
import type { CanUseToolFn, ToolContext } from '../../../../../src/host/protocol/tools';
const { ToolExecutor } = await import('../../../../../src/host/tools/toolExecutor');
const { resetToolResolver } = await import('../../../../../src/host/tools/dispatch/toolResolver');

const modules = [calendarCreateEventModule, calendarUpdateEventModule];
let session = 0;

function executor(requestPermission: ConstructorParameters<typeof ToolExecutor>[0]['requestPermission']) {
  const instance = new ToolExecutor({ workingDirectory: process.cwd(), requestPermission, forcePermissionHandler: true });
  instance.setAuditEnabled(false);
  return instance;
}

function ctx(): ToolContext {
  return {
    sessionId: 'cal-local', workingDir: process.cwd(), abortSignal: new AbortController().signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, emit: () => void 0,
  } as unknown as ToolContext;
}

const eventData = (title: string, startAtMs: number, endAtMs: number) =>
  ({ data: { uid: 'evt-1', calendar: 'Work', title, startAtMs, endAtMs } });

beforeEach(() => {
  resetToolResolver();
  mocks.getSchemas.mockReturnValue(modules.map((m) => m.schema));
  mocks.has.mockImplementation((name: string) => modules.some((m) => m.schema.name === name));
  mocks.resolve.mockImplementation((name: string) => modules.find((m) => m.schema.name === name)?.createHandler());
  mocks.connectorExecute.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('calendar_create_event start_local/end_local through ToolExecutor.execute', () => {
  it.each([
    ['next day', 'Asia/Shanghai', '2026-11-16 15:00', undefined, '2026-11-16T15:00:00+08:00', undefined],
    ['next day', 'America/Los_Angeles', '2026-11-16 15:00', undefined, '2026-11-16T15:00:00-08:00', undefined],
    ['explicit date Nov 17', 'America/Los_Angeles', '2026-11-17 15:00', undefined, '2026-11-17T15:00:00-08:00', undefined],
    ['explicit date Nov 17', 'Asia/Shanghai', '2026-11-17 15:00', '2026-11-17 16:30', '2026-11-17T15:00:00+08:00', '2026-11-17T16:30:00+08:00'],
    ['month/year rollover +1h end', 'Asia/Shanghai', '2026-12-31 23:30', '2027-01-01 00:30', '2026-12-31T23:30:00+08:00', '2027-01-01T00:30:00+08:00'],
    ['month rollover', 'America/Los_Angeles', '2026-02-28 23:30', '2026-03-01 00:30', '2026-02-28T23:30:00-08:00', '2026-03-01T00:30:00-08:00'],
    ['fall-back day, after the repeated hour', 'America/Los_Angeles', '2026-11-01 03:00', undefined, '2026-11-01T03:00:00-08:00', undefined],
    ['fall-back day, repeated hour = first occurrence', 'America/Los_Angeles', '2026-11-01 01:30', undefined, '2026-11-01T01:30:00-07:00', undefined],
    ['spring-forward day, after the gap', 'America/Los_Angeles', '2026-03-08 03:30', undefined, '2026-03-08T03:30:00-07:00', undefined],
  ])('%s in %s: %s -> approval card and connector receive the exact instant', async (_name, zone, startLocal, endLocal, startIso, endIso) => {
    vi.stubEnv('TZ', zone);
    const startMs = Date.parse(startIso);
    const endMs = endIso ? Date.parse(endIso) : undefined;
    const requestPermission = vi.fn(async (request: PermissionRequestData) => {
      expect(mocks.connectorExecute).not.toHaveBeenCalled();
      expect(request.details).toMatchObject({ start_ms: startMs });
      if (endMs !== undefined) expect(request.details).toMatchObject({ end_ms: endMs });
      expect(request.details).not.toHaveProperty('start_local');
      expect(request.details).not.toHaveProperty('end_local');
      const preview = (request.details as { preview?: { diff?: string } }).preview;
      expect(preview?.diff).toContain(`Start: ${new Date(startMs).toLocaleString('zh-CN', { timeZone: zone })}`);
      return true;
    });
    mocks.connectorExecute.mockResolvedValue(eventData('Weekly sync', startMs, endMs ?? startMs + 1_800_000));
    const args: Record<string, unknown> = { title: 'Weekly sync', start_local: startLocal };
    if (endLocal) args.end_local = endLocal;
    const result = await executor(requestPermission).execute('calendar_create_event', args, { sessionId: `cal-${++session}` });
    expect(result).toMatchObject({ success: true });
    expect(requestPermission).toHaveBeenCalledOnce();
    const sent: Record<string, unknown> = { title: 'Weekly sync', start_ms: startMs };
    if (endMs !== undefined) sent.end_ms = endMs;
    expect(mocks.connectorExecute).toHaveBeenCalledWith('create_event', sent);
    expect(args).not.toHaveProperty('start_ms');
  });

  it('renders the user-asked wall clock on the approval card (tomorrow 3pm, Los Angeles)', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    let diff = '';
    const requestPermission = vi.fn(async (request: PermissionRequestData) => {
      diff = String((request.details as { preview?: { diff?: string } }).preview?.diff);
      return false;
    });
    await executor(requestPermission).execute('calendar_create_event', { title: 'Weekly sync', start_local: '2026-11-16 15:00' }, { sessionId: `cal-${++session}` });
    expect(diff).toContain('Start: 2026/11/16 15:00:00');
  });

  it('rejects a nonexistent DST-gap time (2026-03-08 02:30 America/Los_Angeles) before the card', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const requestPermission = vi.fn(async () => true);
    const result = await executor(requestPermission).execute('calendar_create_event', { title: 'Gap', start_local: '2026-03-08 02:30' }, { sessionId: `cal-${++session}` });
    expect(result).toMatchObject({
      success: false, metadata: { code: 'INVALID_ARGS' },
      error: expect.stringContaining('start_local must be a valid existing host-local wall-clock time in YYYY-MM-DD HH:mm format'),
    });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mocks.connectorExecute).not.toHaveBeenCalled();
  });

  it.each([
    ['bad format', { start_local: 'tomorrow 3pm' }, 'start_local'],
    ['offset suffix', { start_local: '2026-11-16 15:00 PST' }, 'start_local'],
    ['rollover date', { start_local: '2026-02-30 09:00' }, 'start_local'],
    ['non-string', { start_local: 1794870000000 }, 'start_local'],
    ['bad end', { start_local: '2026-11-16 15:00', end_local: '2026-11-16T16:00' }, 'end_local'],
    ['both start forms', { start_local: '2026-11-16 15:00', start_ms: 1794870000000 }, 'Supply only one of start_local and start_ms'],
    ['both end forms', { start_local: '2026-11-16 15:00', end_local: '2026-11-16 16:00', end_ms: 1794873600000 }, 'Supply only one of end_local and end_ms'],
  ])('rejects %s with INVALID_ARGS before the approval card', async (_name, extra, message) => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    const requestPermission = vi.fn(async () => true);
    const result = await executor(requestPermission).execute('calendar_create_event', { title: 'Bad', ...extra }, { sessionId: `cal-${++session}` });
    expect(result).toMatchObject({ success: false, metadata: { code: 'INVALID_ARGS' }, error: expect.stringContaining(message) });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mocks.connectorExecute).not.toHaveBeenCalled();
  });

  it('legacy start_ms / end_ms still work unchanged', async () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    const startMs = Date.parse('2026-11-16T07:00:00Z');
    const endMs = startMs + 3_600_000;
    const requestPermission = vi.fn(async (request: PermissionRequestData) => {
      expect(request.details).toMatchObject({ start_ms: startMs, end_ms: endMs });
      return true;
    });
    mocks.connectorExecute.mockResolvedValue(eventData('Legacy', startMs, endMs));
    const result = await executor(requestPermission).execute('calendar_create_event', { title: 'Legacy', start_ms: startMs, end_ms: endMs }, { sessionId: `cal-${++session}` });
    expect(result).toMatchObject({ success: true });
    expect(mocks.connectorExecute).toHaveBeenCalledWith('create_event', { title: 'Legacy', start_ms: startMs, end_ms: endMs });
  });

  it('a card edit of start_ms stays authoritative over the original start_local', async () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    const editedMs = Date.parse('2026-11-16T08:15:00Z');
    mocks.connectorExecute.mockResolvedValue(eventData('Edited', editedMs, editedMs + 1_800_000));
    const requestPermission = vi.fn(async () => ({ approved: true, updatedArgs: { start_ms: editedMs } }));
    await executor(requestPermission).execute('calendar_create_event', { calendar: 'Work', title: 'Edited', start_local: '2026-11-16 15:00' }, { sessionId: `cal-${++session}` });
    expect(mocks.connectorExecute).toHaveBeenCalledWith('create_event', { calendar: 'Work', title: 'Edited', start_ms: editedMs });
  });
});

describe('calendar_create_event module entry (direct calls, no ToolExecutor)', () => {
  it.each([
    ['Asia/Shanghai', '2026-11-16 15:00', '2026-11-16T15:00:00+08:00'],
    ['America/Los_Angeles', '2026-11-16 15:00', '2026-11-16T15:00:00-08:00'],
  ])('%s %s converts and keeps the default end (+30 min) to the connector', async (zone, local, iso) => {
    vi.stubEnv('TZ', zone);
    const ms = Date.parse(iso);
    mocks.connectorExecute.mockResolvedValue(eventData('Weekly sync', ms, ms + 1_800_000));
    const canUseTool = vi.fn<CanUseToolFn>(async () => ({ allow: true }));
    const result = await (await calendarCreateEventModule.createHandler()).execute({ title: 'Weekly sync', start_local: local }, ctx(), canUseTool);
    expect(result.ok).toBe(true);
    expect(canUseTool).toHaveBeenCalledWith('calendar_create_event', { title: 'Weekly sync', start_ms: ms });
    expect(mocks.connectorExecute).toHaveBeenCalledWith('create_event', { title: 'Weekly sync', start_ms: ms });
  });

  it('rejects the DST gap, both forms, and a missing start with the exact expected format', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const handler = await calendarCreateEventModule.createHandler();
    const allow: CanUseToolFn = async () => ({ allow: true });
    expect(await handler.execute({ title: 'x', start_local: '2026-03-08 02:30' }, ctx(), allow))
      .toMatchObject({ ok: false, code: 'INVALID_ARGS', error: expect.stringContaining('YYYY-MM-DD HH:mm') });
    expect(await handler.execute({ title: 'x', start_local: '2026-11-16 15:00', start_ms: 1 }, ctx(), allow))
      .toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(await handler.execute({ title: 'x' }, ctx(), allow))
      .toMatchObject({ ok: false, code: 'INVALID_ARGS', error: expect.stringContaining('start_local') });
    expect(mocks.connectorExecute).not.toHaveBeenCalled();
  });

  it('legacy start_ms still works at module entry', async () => {
    mocks.connectorExecute.mockResolvedValue(eventData('x', 1700000000000, 1700001800000));
    const result = await (await calendarCreateEventModule.createHandler()).execute({ title: 'x', start_ms: 1700000000000 }, ctx(), async () => ({ allow: true }));
    expect(result.ok).toBe(true);
    expect(mocks.connectorExecute).toHaveBeenCalledWith('create_event', { title: 'x', start_ms: 1700000000000 });
  });
});

describe('calendar_update_event start_local/end_local', () => {
  it('moves an event to a new local time through ToolExecutor.execute (card and connector see the ms)', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const startMs = Date.parse('2026-11-17T16:00:00-08:00');
    const endMs = Date.parse('2026-11-17T17:00:00-08:00');
    const requestPermission = vi.fn(async (request: PermissionRequestData) => {
      expect(request.details).toMatchObject({ start_ms: startMs, end_ms: endMs });
      expect(request.details).not.toHaveProperty('start_local');
      return true;
    });
    mocks.connectorExecute.mockResolvedValue(eventData('Weekly sync', startMs, endMs));
    const result = await executor(requestPermission).execute(
      'calendar_update_event',
      { calendar: 'Work', event_uid: 'evt-1', start_local: '2026-11-17 16:00', end_local: '2026-11-17 17:00' },
      { sessionId: `cal-${++session}` },
    );
    expect(result).toMatchObject({ success: true });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(mocks.connectorExecute).toHaveBeenCalledWith('update_event', { calendar: 'Work', event_uid: 'evt-1', start_ms: startMs, end_ms: endMs });
  });

  it('module entry converts, and rejects gap / both forms; legacy ms still works', async () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    const handler = await calendarUpdateEventModule.createHandler();
    const allow: CanUseToolFn = async () => ({ allow: true });
    const ms = Date.parse('2026-12-31T23:30:00+08:00');
    mocks.connectorExecute.mockResolvedValue(eventData('x', ms, ms + 3_600_000));
    expect((await handler.execute({ calendar: 'Work', event_uid: 'e', start_local: '2026-12-31 23:30', end_local: '2027-01-01 00:30' }, ctx(), allow)).ok).toBe(true);
    expect(mocks.connectorExecute).toHaveBeenCalledWith('update_event', { calendar: 'Work', event_uid: 'e', start_ms: ms, end_ms: ms + 3_600_000 });
    expect(await handler.execute({ calendar: 'Work', event_uid: 'e', start_local: '2026-12-31 23:30', start_ms: ms }, ctx(), allow))
      .toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(await handler.execute({ calendar: 'Work', event_uid: 'e', end_local: '2026-03-08 02:30' }, ctx(), allow))
      .toMatchObject({ ok: false, code: 'INVALID_ARGS', error: expect.stringContaining('end_local') });
    mocks.connectorExecute.mockClear();
    expect((await handler.execute({ calendar: 'Work', event_uid: 'e', start_ms: ms }, ctx(), allow)).ok).toBe(true);
    expect(mocks.connectorExecute).toHaveBeenCalledWith('update_event', { calendar: 'Work', event_uid: 'e', start_ms: ms });
  });
});
