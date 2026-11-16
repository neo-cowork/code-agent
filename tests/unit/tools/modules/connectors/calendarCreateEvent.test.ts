// ============================================================================
// CalendarCreateEvent (native ToolModule) Tests — P0-6.3 Batch 6
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

import { calendarCreateEventModule } from '../../../../../src/host/tools/modules/connectors/calendarCreateEvent';
import { CalendarFailure } from '../../../../../src/host/connectors/native/calendar';
import { formatConnectorTime } from '../../../../../src/host/tools/modules/connectors/connectorTime';

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

const validArgs = { calendar: 'Work', title: 'Standup', start_ms: 1700000000000 };

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await calendarCreateEventModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  execMock.mockReset();
  getMock.mockReset();
  getMock.mockReturnValue({ execute: execMock });
});

describe('calendarCreateEventModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(calendarCreateEventModule.schema.name).toBe('calendar_create_event');
      expect(calendarCreateEventModule.schema.category).toBe('mcp');
      expect(calendarCreateEventModule.schema.permissionLevel).toBe('write');
      expect(calendarCreateEventModule.schema.readOnly).toBe(false);
      expect(calendarCreateEventModule.schema.allowInPlanMode).toBe(false);
      expect(calendarCreateEventModule.schema.inputSchema.required).toEqual([
        'title',
        'start_ms',
      ]);
    });
  });

  describe('validation & errors', () => {
    it('allows missing calendar and passes it through to the connector', async () => {
      execMock.mockResolvedValue({
        data: {
          uid: 'evt-default',
          calendar: '日历',
          title: 'x',
          startAtMs: 1,
          endAtMs: 1_800_001,
        },
      });
      const result = await run({ title: 'x', start_ms: 1 });
      expect(result.ok).toBe(true);
      expect(execMock).toHaveBeenCalledWith('create_event', { title: 'x', start_ms: 1 });
    });

    it('without a calendar, the approval card is asked with the real default calendar name (not「无」) and the write lands there', async () => {
      execMock.mockImplementation(async (action: string) => (action === 'default_calendar'
        ? { data: '家庭' }
        : { data: { uid: 'e', calendar: '家庭', title: 'x', startAtMs: 1, endAtMs: 2 } }));
      const seen: Array<Record<string, unknown>> = [];
      const result = await run({ title: 'x', start_ms: 1 }, makeCtx(), async (_tool, args) => { seen.push(args as Record<string, unknown>); return { allow: true }; });
      expect(result.ok).toBe(true);
      expect(seen).toEqual([{ title: 'x', start_ms: 1, calendar: '家庭' }]);
      expect(execMock).toHaveBeenCalledWith('create_event', { title: 'x', start_ms: 1, calendar: '家庭' });
    });

    it('rejects missing title', async () => {
      const result = await run({ calendar: 'Work', start_ms: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing start_ms', async () => {
      const result = await run({ calendar: 'Work', title: 'x' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('allows an empty calendar string and passes it through to the connector', async () => {
      execMock.mockResolvedValue({
        data: {
          uid: 'evt-default',
          calendar: '日历',
          title: 'x',
          startAtMs: 1,
          endAtMs: 1_800_001,
        },
      });
      const result = await run({ calendar: '', title: 'x', start_ms: 1 });
      expect(result.ok).toBe(true);
      expect(execMock).toHaveBeenCalledWith('create_event', { calendar: '', title: 'x', start_ms: 1 });
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run(validArgs, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run(validArgs, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns NOT_INITIALIZED when connector missing', async () => {
      getMock.mockReturnValue(undefined);
      const result = await run(validArgs);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_INITIALIZED');
        expect(result.error).toContain('Calendar is not connected on this computer, so calendar events cannot be created');
        expect(result.error).toContain('Connectors page');
        expect(result.error).not.toContain('connector is not available');
      }
    });

    it('passes the EventKit not_authorized code through (permission card) with plain copy only', async () => {
      const ctx = makeCtx();
      execMock.mockRejectedValue(new CalendarFailure('not_authorized'));
      const result = await run(validArgs, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('not_authorized');
        expect(result.error).toBe(new CalendarFailure('not_authorized').message);
        const failed = result as typeof result & { meta?: { failureReason?: string; artifact?: { metadata?: { failureReason?: string } } } };
        expect(failed.meta?.failureReason).toBe(result.error);
        expect(failed.meta?.artifact?.metadata?.failureReason).toBe(result.error);
      }
      expect(ctx.logger.warn).toHaveBeenCalledWith('calendar_create_event failed', { connector: 'calendar', code: 'not_authorized' });
    });

    it('treats a bridge timeout as an unconfirmed write instead of recommending a retry', async () => {
      const { calendarConnector, resetCalendarConnectorReadiness } = await import('../../../../../src/host/connectors/native/calendar');
      const client = await import('../../../../../src/host/permissions/envAssist/shellBridge/client');
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const spy = vi.spyOn(client, 'resolveShellBridgeClientFromEnv').mockReturnValue({
        post: async <T,>(path: string): Promise<T> => {
          if (path === '/v1/read/calendars') return { calendars: [{ id: 'c1', title: 'Work', writable: true }] } as T;
          throw new Error('env_assist_bridge:bridge_unreachable'); // 写到一半桥超时
        },
      });
      try {
        resetCalendarConnectorReadiness();
        execMock.mockImplementation((action: string, args: Record<string, unknown>) => calendarConnector.execute(action, args));
        const result = await run(validArgs, makeCtx());
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toMatch(/结果无法确认|result is unknown/i);
          expect(result.error).toMatch(/不要直接重试|do not retry/i);
          expect(result.error).not.toMatch(/请稍后再试|try again later/i);
        }
      } finally {
        spy.mockRestore();
        Object.defineProperty(process, 'platform', platform);
        resetCalendarConnectorReadiness();
      }
    });

    it('passes through a non-AppleScript connector error unchanged', async () => {
      const ctx = makeCtx();
      execMock.mockRejectedValue(new Error('calendar validation failed'));
      const result = await run(validArgs, ctx);
      expect(result).toMatchObject({ ok: false, error: 'Calendar create failed: calendar validation failed' });
      expect(ctx.logger.warn).not.toHaveBeenCalled();
    });

    it('wraps connector errors', async () => {
      execMock.mockRejectedValue(new Error('boom'));
      const result = await run(validArgs);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Calendar create failed: boom');
      expect((result as { meta?: { artifact?: unknown } }).meta?.artifact).toMatchObject({
        role: 'receipt',
        metadata: { success: false, failureReason: expect.any(String) },
      });
    });
  });

  describe('happy path', () => {
    it('creates event and formats output', async () => {
      execMock.mockResolvedValue({
        data: {
          uid: 'evt-created',
          calendar: 'Work',
          title: 'Standup',
          startAtMs: 1700000000000,
          endAtMs: 1700001800000,
          location: 'Zoom',
        },
      });
      const result = await run(validArgs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('已创建日历事件：');
        expect(result.output).toContain('- [Work] Standup');
        expect(result.output).toContain('- 开始：');
        expect(result.output).toContain('- 地点：Zoom');
        expect(result.meta?.previewItem).toMatchObject({
          kind: 'calendar_event',
          title: 'Standup',
          subtitle: 'Work',
          status: 'ready',
        });
        expect(result.meta).toMatchObject({
          action: 'create_event',
          connector: 'calendar',
          uid: 'evt-created',
          undoable: true,
          calendar: 'Work',
          title: 'Standup',
        });
        const artifact = result.meta?.artifact as {
          kind?: string;
          role?: string;
          name?: string;
          metadata?: Record<string, unknown>;
        };
        expect(artifact).toMatchObject({
          kind: 'text',
          role: 'receipt',
          name: `已创建日历事件：Standup（${formatConnectorTime(1700000000000)}）`,
        });
        expect(artifact.metadata?.action).toBe('create_event');
        expect(artifact.metadata).toMatchObject({
          uid: 'evt-created',
          undoable: true,
        });
      }
      expect(execMock).toHaveBeenCalledWith('create_event', validArgs);
    });

    it('marks the receipt non-undoable when create returns no uid', async () => {
      execMock.mockResolvedValue({
        data: { calendar: 'Work', title: 'Standup', startAtMs: 1, endAtMs: 2 },
      });
      const result = await run(validArgs);
      expect(result).toMatchObject({
        ok: true,
        meta: {
          undoable: false,
          undoUnavailableReason: expect.stringContaining('stable uid'),
          artifact: {
            metadata: {
              undoable: false,
              undoUnavailableReason: expect.stringContaining('stable uid'),
            },
          },
        },
      });
    });

    it('emits starting progress', async () => {
      execMock.mockResolvedValue({
        data: { calendar: 'Work', title: 'x', startAtMs: 1, endAtMs: 2 },
      });
      const onProgress = vi.fn();
      await run(validArgs, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
