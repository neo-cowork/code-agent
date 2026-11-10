// ============================================================================
// RemindersCreate (native ToolModule) Tests — P0-6.3 Batch 5
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

import { remindersCreateModule } from '../../../../../src/host/tools/modules/connectors/remindersCreate';

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
