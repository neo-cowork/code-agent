// ============================================================================
// Calendar (native ToolModule) Tests — P0-6.3 Batch 6
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';

const execMock = vi.fn();
const getMock = vi.fn();

vi.mock('../../../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({
    get: getMock,
  }),
}));

import { calendarModule } from '../../../../../src/host/tools/modules/connectors/calendar';
import { CalendarFailure } from '../../../../../src/host/connectors/native/calendar';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await calendarModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  execMock.mockReset();
  getMock.mockReset();
  getMock.mockReturnValue({ execute: execMock });
});

describe('calendarModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(calendarModule.schema.name).toBe('calendar');
      expect(calendarModule.schema.category).toBe('mcp');
      expect(calendarModule.schema.permissionLevel).toBe('read');
      expect(calendarModule.schema.readOnly).toBe(true);
      expect(calendarModule.schema.allowInPlanMode).toBe(true);
      expect(calendarModule.schema.inputSchema.required).toEqual(['action']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing action', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects unknown action', async () => {
      const result = await run({ action: 'wipe_everything' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ action: 'get_status' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ action: 'get_status' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns unavailable status when get_status connector is missing', async () => {
      getMock.mockReturnValue(undefined);
      const result = await run({ action: 'get_status' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain(
          'Calendar is not connected on this computer, so calendar events cannot be read.',
        );
        expect(result.output).toContain('Connectors page');
        expect(result.output).not.toMatch(/connector:\s*(unavailable|connected|disconnected)/i);
        expect(result.output).not.toContain('Capabilities:');
        expect(result.meta).toMatchObject({
          status: {
            connected: false,
            unavailable: true,
            capabilities: [],
          },
        });
      }
    });

    it('returns NOT_INITIALIZED when data action connector is missing', async () => {
      getMock.mockReturnValue(undefined);
      const result = await run({ action: 'list_calendars' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_INITIALIZED');
        expect(result.error).toContain('Calendar is not connected on this computer, so calendar events cannot be read');
        expect(result.error).toContain('Connectors page');
        expect(result.error).toContain('能力中心 > 连接器');
        expect(result.error).not.toContain('设置 > 连接器');
        expect(result.error).toContain('never state that there are no events');
        expect(result.error).toContain('other sources');
        expect(result.error).not.toContain('connector is not available');
      }
    });

    it('passes the EventKit failure code through (not_authorized drives the permission card) with no native detail', async () => {
      for (const code of ['not_authorized', 'not_found', 'unavailable', 'read_failed'] as const) {
        execMock.mockRejectedValueOnce(new CalendarFailure(code));
        const ctx = makeCtx();
        const result = await run({ action: 'list_events' }, ctx);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(code);
          expect(result.error).toBe(new CalendarFailure(code).message);
          expect(result.error).not.toMatch(/osascript|AppleScript|Automation|自动化/);
        }
        expect(vi.mocked(ctx.logger.warn).mock.calls[0][1]).toEqual({ connector: 'calendar', code });
      }
    });

    it('keeps connector validation errors intact instead of rewriting to a retry hint', async () => {
      execMock.mockRejectedValue(new Error('end_ms must be greater than or equal to start_ms'));
      const result = await run({ action: 'get_status' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('end_ms must be greater than or equal to start_ms');
        expect(result.error).not.toContain('读取失败');
      }
    });
  });

  describe('actions happy path', () => {
    it('get_status formats connected status', async () => {
      execMock.mockResolvedValue({
        data: { connected: true, detail: 'EventKit OK', capabilities: ['read', 'write'] },
      });
      const result = await run({ action: 'get_status' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Calendar is connected. EventKit OK.');
        expect(result.output).toContain('It supports read and write.');
        expect(result.output).not.toMatch(/connector:\s*(unavailable|connected|disconnected)/i);
        expect(result.output).not.toContain('Capabilities:');
        expect(result.meta).toMatchObject({
          action: 'get_status',
          connector: 'calendar',
          status: { connected: true, detail: 'EventKit OK', capabilities: ['read', 'write'] },
        });
        const artifact = result.meta?.artifact as { kind?: string; metadata?: Record<string, unknown> };
        expect(artifact.kind).toBe('text');
        expect(artifact.metadata?.action).toBe('get_status');
      }
    });

    it('get_status formats disconnected status and humanizes snake_case capabilities when connected', async () => {
      execMock.mockResolvedValueOnce({
        data: { connected: false, detail: 'Automation permission needed', capabilities: ['get_status', 'list_events'] },
      });
      const disconnected = await run({ action: 'get_status' });
      expect(disconnected.ok).toBe(true);
      if (disconnected.ok) {
        expect(disconnected.output).toContain(
          'Calendar is not connected right now, so calendar events cannot be read.',
        );
        expect(disconnected.output).toContain('Automation permission needed.');
        expect(disconnected.output).toContain('Connectors page');
        expect(disconnected.output).not.toMatch(/connector:\s*(unavailable|connected|disconnected)/i);
        expect(disconnected.output).not.toContain('Capabilities:');
      }

      execMock.mockResolvedValueOnce({
        data: { connected: true, detail: 'EventKit OK', capabilities: ['get_status', 'list_calendars', 'list_events'] },
      });
      const connected = await run({ action: 'get_status' });
      expect(connected.ok).toBe(true);
      if (connected.ok) {
        expect(connected.output).toContain('It supports list calendars and list events.');
        expect(connected.output).not.toContain('list_events');
        expect(connected.output).not.toContain('Capabilities:');
      }
    });

    it('list_calendars formats calendar names', async () => {
      execMock.mockResolvedValue({ data: ['Home', 'Work', 'Birthdays'] });
      const result = await run({ action: 'list_calendars' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('可用日历 (3)');
        expect(result.output).toContain('- Home');
        expect(result.output).toContain('- Work');
        expect(result.output).toContain('- Birthdays');
      }
    });

    it('list_calendars empty fallback', async () => {
      execMock.mockResolvedValue({ data: [] });
      const result = await run({ action: 'list_calendars' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('没有找到可访问的日历。');
    });

    it('list_events formats events with uid and location', async () => {
      execMock.mockResolvedValue({
        data: [
          {
            calendar: 'Work',
            title: 'Standup',
            startAtMs: 1700000000000,
            endAtMs: 1700001800000,
            location: 'Zoom',
            uid: 'evt-1',
          },
          {
            calendar: 'Home',
            title: 'Dinner',
            startAtMs: 1700100000000,
            endAtMs: 1700103600000,
          },
        ],
      });
      const result = await run({ action: 'list_events' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('日历事件 (2)');
        expect(result.output).toContain('[Work] Standup');
        expect(result.output).toContain('| Zoom');
        expect(result.output).toContain('uid: evt-1');
        expect(result.output).toContain('[Home] Dinner');
        expect(result.meta).toMatchObject({
          action: 'list_events',
          connector: 'calendar',
          count: 2,
        });
        const artifact = result.meta?.artifact as { kind?: string; metadata?: Record<string, unknown> };
        expect(artifact.kind).toBe('text');
        expect(artifact.metadata?.count).toBe(2);
      }
    });

    it('list_events empty fallback', async () => {
      execMock.mockResolvedValue({ data: [] });
      const result = await run({ action: 'list_events' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('以下时间均按该时区显示。');
        expect(result.output).toContain('没有找到匹配的日历事件。');
      }
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      execMock.mockResolvedValue({ data: [] });
      const onProgress = vi.fn();
      await run({ action: 'list_calendars' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
