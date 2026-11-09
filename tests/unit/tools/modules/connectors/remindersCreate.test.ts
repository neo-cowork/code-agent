// ============================================================================
// RemindersCreate (native ToolModule) Tests — P0-6.3 Batch 5
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfirmationGate } from '../../../../../src/host/agent/confirmationGate';
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

import { remindersCreateModule } from '../../../../../src/host/tools/modules/connectors/remindersCreate';
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

const validArgs = { list: 'Work', title: 'Ship PR' };

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await remindersCreateModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  execMock.mockReset();
  getMock.mockReset();
  getMock.mockReturnValue({ execute: execMock });
});

describe('remindersCreateModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(remindersCreateModule.schema.name).toBe('reminders_create');
      expect(remindersCreateModule.schema.category).toBe('mcp');
      expect(remindersCreateModule.schema.permissionLevel).toBe('write');
      expect(remindersCreateModule.schema.readOnly).toBe(false);
      expect(remindersCreateModule.schema.allowInPlanMode).toBe(false);
      expect(remindersCreateModule.schema.inputSchema.required).toEqual(['title']);
    });
  });

  describe('validation & errors', () => {
    it('allows missing list and passes it through to the connector', async () => {
      execMock.mockResolvedValue({
        data: { id: 'r-default', list: '提醒事项', title: 'x', completed: false },
      });
      const result = await run({ title: 'x' });
      expect(result.ok).toBe(true);
      expect(execMock).toHaveBeenCalledWith('create_reminder', { title: 'x' });
    });

    it('rejects missing title', async () => {
      const result = await run({ list: 'Work' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('allows an empty list string and passes it through to the connector', async () => {
      execMock.mockResolvedValue({
        data: { id: 'r-default', list: '提醒事项', title: 'x', completed: false },
      });
      const result = await run({ list: '', title: 'x' });
      expect(result.ok).toBe(true);
      expect(execMock).toHaveBeenCalledWith('create_reminder', { list: '', title: 'x' });
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
      if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    });

    it('wraps connector errors', async () => {
      execMock.mockRejectedValue(new Error('boom'));
      const result = await run(validArgs);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Reminders create failed: boom');
      expect((result as { meta?: { artifact?: unknown } }).meta?.artifact).toMatchObject({
        role: 'receipt',
        metadata: { success: false, failureReason: expect.any(String) },
      });
    });

    it('sanitizes osascript failure and adds no-Bash/osascript guidance when nothing was created', async () => {
      const osascriptError = Object.assign(
        new Error('Command failed: osascript -e \'tell application "Reminders" to make new reminder\''),
        { killed: true, signal: 'SIGTERM' },
      );
      execMock
        .mockRejectedValueOnce(osascriptError)
        .mockResolvedValueOnce({ data: [] });

      const ctx = makeCtx();
      const result = await run(validArgs, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain('osascript -e');
        expect(result.error).not.toContain('make new reminder');
        expect(result.error).toContain('Nothing was created.');
        expect(result.error).toMatch(/do not work around this by running osascript|Bash/i);
        expect(result.error).toMatch(/at most retry reminders_create once/i);
      }
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        'reminders_create osascript failed',
        expect.objectContaining({ connector: 'reminders', code: 'timeout' }),
      );
    });

    it('reconciles to ok:true when create times out on osascript but list_reminders finds a matching reminder', async () => {
      const remindAtMs = 1_760_000_000_000;
      const osascriptError = Object.assign(
        new Error('Command failed: osascript -e \'tell application "Reminders" to make new reminder\''),
        { killed: true, signal: 'SIGTERM' },
      );
      execMock
        .mockRejectedValueOnce(osascriptError)
        .mockResolvedValueOnce({
          data: [
            {
              id: 'r-reconciled',
              list: 'Work',
              title: 'Ship PR',
              completed: false,
              notes: 'check gates',
              remindAtMs: remindAtMs + 30_000,
            },
          ],
        });

      const result = await run({
        list: 'Work',
        title: '  Ship PR  ',
        notes: 'check gates',
        remind_at_ms: remindAtMs,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('- [Work] Ship PR');
        expect(result.output).toContain('already exists');
        expect(result.meta).toMatchObject({
          action: 'create_reminder',
          connector: 'reminders',
          id: 'r-reconciled',
          undoable: true,
          list: 'Work',
          title: 'Ship PR',
          completed: false,
        });
      }
      const createCalls = execMock.mock.calls.filter((c) => c[0] === 'create_reminder');
      expect(createCalls).toHaveLength(1);
      expect(execMock).toHaveBeenCalledWith('list_reminders', { list: 'Work', limit: 200 });
    });

    it('reconciles titles and notes after list_reminders sanitizes line delimiters', async () => {
      const osascriptError = Object.assign(
        new Error('Command failed: osascript -e \'tell application "Reminders" to make new reminder\''),
        { killed: true, signal: 'SIGTERM' },
      );
      execMock
        .mockRejectedValueOnce(osascriptError)
        .mockResolvedValueOnce({
          data: [
            {
              id: 'r-sanitized',
              list: 'Work',
              title: 'Ship PR urgent today',
              completed: false,
              notes: 'line 1 line 2 line 3 line 4 detail',
            },
          ],
        });

      const result = await run({
        list: 'Work',
        title: '  Ship\nPR\turgent|today  ',
        notes: '  line 1\rline 2\nline 3\tline 4|detail  ',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('- [Work] Ship PR urgent today');
        expect(result.meta).toMatchObject({ id: 'r-sanitized' });
      }
      const createCalls = execMock.mock.calls.filter((call) => call[0] === 'create_reminder');
      expect(createCalls).toHaveLength(1);
    });

    it('returns ok:false unconfirmed when reconcile list_reminders also rejects', async () => {
      const osascriptError = Object.assign(
        new Error('Command failed: osascript -e \'tell application "Reminders" to make new reminder\''),
        { killed: true, signal: 'SIGTERM' },
      );
      const listError = Object.assign(
        new Error('Command failed: osascript -e \'tell application "Reminders" to get every reminder\''),
        { killed: true, signal: 'SIGTERM' },
      );
      execMock
        .mockRejectedValueOnce(osascriptError)
        .mockRejectedValueOnce(listError);

      const result = await run(validArgs);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/could not be confirmed/i);
        expect(result.error).toMatch(/do not retry blindly/i);
        expect(result.error).toMatch(/check the Reminders list/i);
        expect(result.error).toMatch(/Do not work around this by running osascript/i);
        expect(result.error).not.toContain('osascript -e');
      }
    });

    it('returns ok:false Nothing was created when reconcile list_reminders finds no matching item', async () => {
      const osascriptError = Object.assign(
        new Error('Command failed: osascript -e \'tell application "Reminders" to make new reminder\''),
        { killed: true, signal: 'SIGTERM' },
      );
      execMock
        .mockRejectedValueOnce(osascriptError)
        .mockResolvedValueOnce({
          data: [
            { id: 'r-other', list: 'Work', title: 'Other task', completed: false },
            { id: 'r-done', list: 'Work', title: 'Ship PR', completed: true },
          ],
        });

      const result = await run(validArgs);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Nothing was created.');
        expect(result.error).toMatch(/Do not work around this by running osascript/i);
      }
    });

    it('treats 200 items without a match as unconfirmed due to possible truncation', async () => {
      const osascriptError = Object.assign(
        new Error('Command failed: osascript -e \'tell application "Reminders" to make new reminder\''),
        { killed: true, signal: 'SIGTERM' },
      );
      const manyItems = Array.from({ length: 200 }, (_, idx) => ({
        id: `r-${idx}`,
        list: 'Work',
        title: `Item ${idx}`,
        completed: false,
      }));
      execMock
        .mockRejectedValueOnce(osascriptError)
        .mockResolvedValueOnce({ data: manyItems });

      const result = await run(validArgs);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/could not be confirmed/i);
        expect(result.error).toMatch(/do not retry blindly/i);
        expect(result.error).toMatch(/check the Reminders list/i);
        expect(result.error).toMatch(/Do not work around this by running osascript/i);
        expect(result.error).not.toContain('Nothing was created.');
      }
    });
  });

  describe('happy path', () => {
    it('creates reminder and formats output', async () => {
      execMock.mockResolvedValue({
        data: { id: 'r-created', list: 'Work', title: 'Ship PR', completed: false },
      });
      const result = await run(validArgs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('已创建提醒：');
        expect(result.output).toContain('- [Work] Ship PR');
        expect(result.output).not.toContain('(completed)');
        expect(result.meta?.previewItem).toMatchObject({
          kind: 'reminder',
          title: 'Ship PR',
          subtitle: 'Work',
          status: 'ready',
        });
        expect(result.meta).toMatchObject({
          action: 'create_reminder',
          connector: 'reminders',
          id: 'r-created',
          undoable: true,
          list: 'Work',
          title: 'Ship PR',
          completed: false,
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
          name: '已创建提醒：Ship PR',
        });
        expect(artifact.metadata?.action).toBe('create_reminder');
        expect(artifact.metadata).toMatchObject({
          id: 'r-created',
          undoable: true,
        });
      }
      expect(execMock).toHaveBeenCalledWith('create_reminder', validArgs);
    });

    it('formats remind_at with the connector time helper', async () => {
      const remindAtMs = Date.UTC(2026, 10, 9, 1, 0);
      execMock.mockResolvedValue({
        data: { id: 'r-time', list: 'Work', title: 'Ship PR', completed: false },
      });
      const result = await run({ ...validArgs, remind_at_ms: remindAtMs });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const preview = result.meta?.previewItem as { content?: { text?: string; summary?: string } };
        expect(preview.content?.text).toContain(`提醒时间：${formatConnectorTime(remindAtMs)}`);
        expect(preview.content?.summary).toContain(formatConnectorTime(remindAtMs));
      }
    });

    it('marks the receipt non-undoable when create returns no id', async () => {
      execMock.mockResolvedValue({
        data: { list: 'Work', title: 'Ship PR', completed: false },
      });
      const result = await run(validArgs);
      expect(result).toMatchObject({
        ok: true,
        meta: {
          undoable: false,
          undoUnavailableReason: expect.stringContaining('stable id'),
          artifact: {
            metadata: {
              undoable: false,
              undoUnavailableReason: expect.stringContaining('stable id'),
            },
          },
        },
      });
    });

    it('emits starting progress', async () => {
      execMock.mockResolvedValue({ data: { list: 'Work', title: 'x', completed: false } });
      const onProgress = vi.fn();
      await run(validArgs, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});

// Authorized fallback: epoch input remains the public contract. These tests prove
// the submitted instant, approval preview and authoritative receipt independently.
describe('reminder time receipt contract', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    ['Asia/Shanghai', '2026-11-08T23:30:00+08:00', '2026-11-09T09:00:00+08:00', '2026-11-09 09:00', '周一'],
    ['Asia/Shanghai', '2026-11-09T00:30:00+08:00', '2026-11-11T14:00:00+08:00', '2026-11-11 14:00', '周三'],
    ['America/Los_Angeles', '2026-03-07T23:30:00-08:00', '2026-03-08T09:00:00-07:00', '2026-03-08 09:00', '周日'],
    ['America/Los_Angeles', '2026-10-31T23:30:00-07:00', '2026-11-02T14:00:00-08:00', '2026-11-02 14:00', '周一'],
  ])('legacy ms without remind_at_local: %s fixed now %s gives approval and read-back receipt %s', async (zone, now, target, wallClock, weekday) => {
    vi.stubEnv('TZ', zone);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const ms = Date.parse(target);
    const args = { title: 'Send weekly report', remind_at_ms: ms };
    execMock.mockResolvedValue({ data: {
      id: 'r-time', list: '提醒事项', title: args.title, completed: false, remindAtMs: ms,
    } });
    const canUseTool = vi.fn(async (name: string, params: Record<string, unknown>) => {
      const preview = new ConfirmationGate().buildPreview(name, params);
      expect(preview?.summary).toBe('创建提醒');
      expect(preview?.diff).toContain(new Date(ms).toLocaleString('zh-CN'));
      expect(new Date(ms).getHours()).toBe(Number(wallClock.slice(11, 13)));
      return { allow: true };
    });
    const result = await run(args, makeCtx(), canUseTool);
    expect(canUseTool).toHaveBeenCalledWith('reminders_create', args);
    expect(execMock).toHaveBeenCalledWith('create_reminder', args);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const receipt = `提醒时间：${wallClock}（${weekday}，${zone}）`;
    expect(result.output).toContain(receipt);
    expect(result.meta?.remindAtMs).toBe(ms);
    expect(result.meta?.previewItem).toMatchObject({ content: { text: expect.stringContaining(receipt) } });
    expect(result.output).toMatch(/提醒时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}（周.，[^）]+）/);
  });

  it('receipt quotes actual read-back rather than the requested instant', async () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    execMock.mockResolvedValue({ data: {
      id: 'r-real', list: '提醒事项', title: 'Dentist', completed: false,
      remindAtMs: Date.parse('2026-11-11T14:00:00+08:00'),
    } });
    const result = await run({ title: 'Dentist', remind_at_ms: Date.parse('2026-11-10T22:00:00+08:00') });
    expect(result).toMatchObject({ ok: true, output: expect.stringContaining('提醒时间：2026-11-11 14:00（周三，Asia/Shanghai）') });
    expect(result).toMatchObject({ meta: { remindAtMs: Date.parse('2026-11-11T14:00:00+08:00') } });
  });

  it('does not invent a requested time when read-back is null or unavailable', async () => {
    for (const [remindAtMs, text] of [[null, '未设置'], [undefined, '无法确认，请在提醒事项中查看']] as const) {
      execMock.mockResolvedValue({ data: { id: 'r-none', list: '提醒事项', title: 'x', completed: false, remindAtMs } });
      expect(await run({ title: 'x', remind_at_ms: 1_800_000_000_000 })).toMatchObject({
        ok: true, output: expect.stringContaining(`提醒时间：${text}`), meta: { remindAtMs: null },
      });
    }
  });

  it('schema tells the model to quote the authoritative receipt time and use the env local date', () => {
    expect(remindersCreateModule.schema.description).toContain('quote that receipt time verbatim');
    expect(remindersCreateModule.schema.description).toContain("Today's date and Local timezone in <env>");
  });
});
