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
import { calendarConnector } from '../../../../../src/host/connectors/native/calendar';
import * as osascript from '../../../../../src/host/connectors/native/osascript';

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
        expect(result.output).toContain('Calendar connector: unavailable');
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
      if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    });

    it('returns a plain reason without the osascript command line', async () => {
      const script = Array.from({ length: 40 }, (_, i) => `set a${i} to ${i}`).join('\n');
      const raw = `Command failed: osascript -e tell application "Calendar"\n${script}\nend tell\nCalendar got an error: Can't get mailbox "INBOX". (-1728)`;
      expect(raw.length).toBeGreaterThan(300);
      execMock.mockRejectedValue(Object.assign(new Error(raw), { code: 1 }));
      const ctx = makeCtx();
      const result = await run({ action: 'get_status' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toMatch(/osascript|Command failed|tell application|set a1 to|end tell/);
        expect(result.error).toContain('Calendar');
        expect(result.error).toContain('检查对应账户');
      }
      const warn = vi.mocked(ctx.logger.warn);
      expect(warn).toHaveBeenCalledTimes(1);
      const meta = warn.mock.calls[0][1] as { connector: string; code: string; detail: string };
      expect(meta).toMatchObject({ connector: 'calendar', code: 'not_found' });
      expect(meta.detail.length).toBeLessThanOrEqual(300);
      expect(meta.detail).toContain('-1728');
      expect(meta.detail).not.toContain('set a1 to');
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
        expect(result.output).toContain('Calendar connector: connected');
        expect(result.output).toContain('EventKit OK');
        expect(result.output).toContain('Capabilities: read, write');
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
      if (result.ok) expect(result.output).toBe('没有找到匹配的日历事件。');
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

  describe('list_events timeout, segmentation, partial result, and retry cap', () => {
    it('distinguishes timeout, not_authorized, and read_failed with actionable next steps', async () => {
      const timeoutErr = Object.assign(new Error('Command failed: osascript -e tell application "Calendar"'), {
        killed: true,
        signal: 'SIGTERM',
      });
      execMock.mockRejectedValueOnce(timeoutErr);
      const rTimeout = await run({ action: 'list_events' }, makeCtx({ sessionId: 'sess-copy-1' }));
      expect(rTimeout.ok).toBe(false);
      if (!rTimeout.ok) {
        expect(rTimeout.code).toBe('timeout');
        expect(rTimeout.error).toBe(
          'Calendar 响应超时：请缩小查询时间范围或指定具体日历名称（calendar），不要原样重试。',
        );
      }

      const authErr = Object.assign(
        new Error('Command failed: osascript -e ...\nNot authorized to send Apple events to Calendar. (-1743)'),
        { code: 1 },
      );
      execMock.mockRejectedValueOnce(authErr);
      const rAuth = await run({ action: 'list_events' }, makeCtx({ sessionId: 'sess-copy-2' }));
      expect(rAuth.ok).toBe(false);
      if (!rAuth.ok) {
        expect(rAuth.code).toBe('not_authorized');
        expect(rAuth.error).toBe(
          'Calendar 未获授权：请在「系统设置 > 隐私与安全性 > 自动化」中允许 Neo 控制 Calendar，然后重试。',
        );
      }

      const readErr = Object.assign(
        new Error('Command failed: osascript -e ...\nsyntax error (-2741)'),
        { code: 1 },
      );
      execMock.mockRejectedValueOnce(readErr);
      const rRead = await run({ action: 'list_events' }, makeCtx({ sessionId: 'sess-copy-3' }));
      expect(rRead.ok).toBe(false);
      if (!rRead.ok) {
        expect(rRead.code).toBe('read_failed');
        expect(rRead.error).toBe('Calendar：读取失败，请稍后重试');
      }
    });

    it('segments no-calendar list_events per calendar, merges sorted by startAtMs, and stops early when limit is reached', async () => {
      const spy = vi.spyOn(osascript, 'runAppleScript');
      try {
        const fromMs = new Date('2026-11-07T00:00:00').getTime();
        const toMs = fromMs + 5 * 24 * 60 * 60 * 1000;
        const timeoutErr = Object.assign(new Error('Command failed: osascript -e set targetCalendars to every calendar'), {
          killed: true,
          signal: 'SIGTERM',
        });
        spy.mockImplementation(async (lines: string[]) => {
          const script = lines.join('\n');
          if (script.includes('set targetCalendars to every calendar')) {
            throw timeoutErr;
          }
          if (script.includes('repeat with cal in every calendar') && !script.includes('matchingEvents')) {
            return 'Work\nPersonal\nHolidays';
          }
          if (script.includes('set targetCalendars to {calendar 1}')) {
            return [
              'u-w2|Work|Late Work|2026-11-09T15:00:00|2026-11-09T16:00:00|Room 2||',
              'u-w1|Work|Early Work|2026-11-08T09:00:00|2026-11-08T10:00:00|Room 1||',
            ].join('\n');
          }
          if (script.includes('set targetCalendars to {calendar 2}')) {
            return 'u-p1|Personal|Mid Personal|2026-11-08T12:00:00|2026-11-08T13:00:00|Cafe||';
          }
          if (script.includes('set targetCalendars to {calendar 3}')) {
            return 'u-h1|Holidays|Holiday Event|2026-11-08T08:00:00|2026-11-08T20:00:00|||';
          }
          return '';
        });

        const res = await calendarConnector.execute('list_events', {
          from_ms: fromMs,
          to_ms: toMs,
          limit: 3,
        });
        const events = res.data as Array<{ uid: string; title: string }>;
        // Collected 2 from Work + 1 from Personal = 3 >= eventLimit(3), so Holidays was not queried!
        expect(spy).toHaveBeenCalledTimes(3);
        for (const call of spy.mock.calls.slice(1)) {
          const scriptText = call[0].join('\n');
          expect(scriptText).not.toContain('set targetCalendars to every calendar');
        }
        expect(events.map((e) => e.uid)).toEqual(['u-w1', 'u-p1', 'u-w2']);
      } finally {
        spy.mockRestore();
      }
    });

    it('truncates merged events to limit after sorting across calendars', async () => {
      const spy = vi.spyOn(osascript, 'runAppleScript');
      try {
        const fromMs = new Date('2026-11-07T00:00:00').getTime();
        const toMs = fromMs + 5 * 24 * 60 * 60 * 1000;
        const timeoutErr = Object.assign(new Error('Command failed: osascript -e set targetCalendars to every calendar'), {
          killed: true,
          signal: 'SIGTERM',
        });
        spy.mockImplementation(async (lines: string[]) => {
          const script = lines.join('\n');
          if (script.includes('set targetCalendars to every calendar')) {
            throw timeoutErr;
          }
          if (script.includes('repeat with cal in every calendar') && !script.includes('matchingEvents')) {
            return 'Work\nPersonal';
          }
          if (script.includes('set targetCalendars to {calendar 1}')) {
            return 'u-w1|Work|Work Afternoon|2026-11-08T14:00:00|2026-11-08T15:00:00|||';
          }
          if (script.includes('set targetCalendars to {calendar 2}')) {
            return [
              'u-p1|Personal|Personal Morning|2026-11-08T08:00:00|2026-11-08T09:00:00|||',
              'u-p2|Personal|Personal Noon|2026-11-08T12:00:00|2026-11-08T13:00:00|||',
            ].join('\n');
          }
          return '';
        });

        const res = await calendarConnector.execute('list_events', {
          from_ms: fromMs,
          to_ms: toMs,
          limit: 2,
        });
        const events = res.data as Array<{ uid: string }>;
        expect(events.map((e) => e.uid)).toEqual(['u-p1', 'u-p2']);
      } finally {
        spy.mockRestore();
      }
    });

    it('queries same-named calendars by index so every calendar is read exactly once', async () => {
      const spy = vi.spyOn(osascript, 'runAppleScript');
      try {
        const fromMs = new Date('2026-11-07T00:00:00').getTime();
        const toMs = fromMs + 5 * 24 * 60 * 60 * 1000;
        spy.mockImplementation(async (lines: string[]) => {
          const script = lines.join('\n');
          if (script.includes('repeat with cal in every calendar') && !script.includes('matchingEvents')) {
            return 'Calendar\nCalendar';
          }
          if (script.includes('set targetCalendars to {calendar 1}')) {
            return 'u-icloud|Calendar|iCloud event|2026-11-08T08:00:00|2026-11-08T09:00:00|||';
          }
          if (script.includes('set targetCalendars to {calendar 2}')) {
            return 'u-exchange|Calendar|Exchange event|2026-11-08T10:00:00|2026-11-08T11:00:00|||';
          }
          if (script.includes('calendar "Calendar"')) {
            return 'u-icloud|Calendar|iCloud event|2026-11-08T08:00:00|2026-11-08T09:00:00|||';
          }
          return '';
        });

        const res = await calendarConnector.execute('list_events', {
          from_ms: fromMs,
          to_ms: toMs,
          limit: 10,
        });
        const events = res.data as Array<{ uid: string }>;
        expect(events.map((event) => event.uid)).toEqual(['u-icloud', 'u-exchange']);
        expect(spy.mock.calls.filter(([lines]) => lines.join('\n').includes('matchingEvents'))).toHaveLength(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('returns partial events plus a note naming unread calendars when one calendar times out', async () => {
      const spy = vi.spyOn(osascript, 'runAppleScript');
      try {
        const fromMs = new Date('2026-11-07T00:00:00').getTime();
        const toMs = fromMs + 5 * 24 * 60 * 60 * 1000;
        const timeoutErr = Object.assign(new Error('Command failed: osascript -e ...'), {
          killed: true,
          signal: 'SIGTERM',
        });
        spy
          .mockResolvedValueOnce('Work\nSlowArchive\nPersonal')
          .mockResolvedValueOnce('u-w1|Work|Standup|2026-11-08T10:00:00|2026-11-08T10:30:00|Zoom||')
          .mockRejectedValueOnce(timeoutErr)
          .mockResolvedValueOnce('u-p1|Personal|Dentist|2026-11-08T09:00:00|2026-11-08T09:30:00|Clinic||');

        getMock.mockReturnValue(calendarConnector);
        const result = await run(
          { action: 'list_events', from_ms: fromMs, to_ms: toMs, limit: 10 },
          makeCtx({ sessionId: 'sess-partial' }),
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.output).toContain('[Personal] Dentist');
          expect(result.output).toContain('[Work] Standup');
          expect(result.output).toContain('SlowArchive');
          expect(result.output).toContain('以下日历读取超时未包含：SlowArchive');
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('enforces a 3-consecutive-timeout retry cap per session and resets on success', async () => {
      const timeoutErr = Object.assign(new Error('Command failed: osascript -e ...'), {
        killed: true,
        signal: 'SIGTERM',
      });
      const ctx = makeCtx({ sessionId: 'sess-retry-cap' });

      execMock.mockRejectedValueOnce(timeoutErr);
      const r1 = await run({ action: 'list_events' }, ctx);
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.error).not.toContain('retry cap reached');

      execMock.mockRejectedValueOnce(timeoutErr);
      const r2 = await run({ action: 'list_events' }, ctx);
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.error).not.toContain('retry cap reached');

      execMock.mockRejectedValueOnce(timeoutErr);
      const r3 = await run({ action: 'list_events' }, ctx);
      expect(r3.ok).toBe(false);
      if (!r3.ok) {
        expect(r3.code).toBe('timeout');
        expect(r3.error).toContain('retry cap reached');
        expect(r3.error).toContain('Stop retrying list_events automatically');
        expect(r3.error).toContain('请停止自动重试');
      }

      // A successful list_events resets the counter for that session
      execMock.mockResolvedValueOnce({ data: [] });
      const rOk = await run({ action: 'list_events' }, ctx);
      expect(rOk.ok).toBe(true);

      execMock.mockRejectedValueOnce(timeoutErr);
      const rAfterReset = await run({ action: 'list_events' }, ctx);
      expect(rAfterReset.ok).toBe(false);
      if (!rAfterReset.ok) expect(rAfterReset.error).not.toContain('retry cap reached');
    });
  });
});
