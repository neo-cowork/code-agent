// ============================================================================
// Reminders (native ToolModule) Tests — P0-6.3 Batch 5
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

import { remindersModule } from '../../../../../src/host/tools/modules/connectors/reminders';
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

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await remindersModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  execMock.mockReset();
  getMock.mockReset();
  getMock.mockReturnValue({ execute: execMock });
});

describe('remindersModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(remindersModule.schema.name).toBe('reminders');
      expect(remindersModule.schema.category).toBe('mcp');
      expect(remindersModule.schema.permissionLevel).toBe('read');
      expect(remindersModule.schema.readOnly).toBe(true);
      expect(remindersModule.schema.allowInPlanMode).toBe(true);
      expect(remindersModule.schema.inputSchema.required).toEqual(['action']);
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
        expect(result.output).toContain('Reminders connector: unavailable');
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
      const result = await run({ action: 'list_lists' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    });

    it('returns a plain reason without the osascript command line', async () => {
      const script = Array.from({ length: 40 }, (_, i) => `set a${i} to ${i}`).join('\n');
      const raw = `Command failed: osascript -e tell application "Reminders"\n${script}\nend tell\nReminders got an error: Can't get mailbox "INBOX". (-1728)`;
      expect(raw.length).toBeGreaterThan(300);
      execMock.mockRejectedValue(Object.assign(new Error(raw), { code: 1 }));
      const ctx = makeCtx();
      const result = await run({ action: 'get_status' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toMatch(/osascript|Command failed|tell application|set a1 to|end tell/);
        expect(result.error).toContain('Reminders');
        expect(result.error).toContain('检查对应账户');
      }
      const warn = vi.mocked(ctx.logger.warn);
      expect(warn).toHaveBeenCalledTimes(1);
      const meta = warn.mock.calls[0][1] as { connector: string; code: string; detail: string };
      expect(meta).toMatchObject({ connector: 'reminders', code: 'not_found' });
      expect(meta.detail.length).toBeLessThanOrEqual(300);
      expect(meta.detail).toContain('-1728');
      expect(meta.detail).not.toContain('set a1 to');
    });

    it('uses list-specific guidance for list_reminders timeouts only', async () => {
      execMock.mockRejectedValue(Object.assign(new Error('Command failed: osascript -e tell application "Reminders"'), { killed: true }));
      const result = await run({ action: 'list_reminders' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/列表名称.*减少读取条数/);
        expect(result.error).not.toMatch(/osascript|tell application|Command failed/);
      }
      const lists = await run({ action: 'list_lists' });
      expect(lists.ok).toBe(false);
      if (!lists.ok) expect(lists.error).not.toMatch(/列表名称.*减少读取条数/);
    });

    it('keeps connector validation errors intact instead of rewriting to a retry hint', async () => {
      execMock.mockRejectedValue(new Error('list is required for get_reminder'));
      const result = await run({ action: 'get_status' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('list is required for get_reminder');
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
        expect(result.output).toContain('Reminders connector: connected');
        expect(result.output).toContain('EventKit OK');
        expect(result.output).toContain('Capabilities: read, write');
        expect(result.meta).toMatchObject({
          action: 'get_status',
          connector: 'reminders',
          status: { connected: true, detail: 'EventKit OK', capabilities: ['read', 'write'] },
        });
        const artifact = result.meta?.artifact as { kind?: string; metadata?: Record<string, unknown> };
        expect(artifact.kind).toBe('text');
        expect(artifact.metadata?.action).toBe('get_status');
      }
    });

    it('list_lists formats list names', async () => {
      execMock.mockResolvedValue({ data: ['Inbox', 'Work', 'Home'] });
      const result = await run({ action: 'list_lists' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('可用提醒列表 (3)');
        expect(result.output).toContain('- Inbox');
        expect(result.output).toContain('- Work');
        expect(result.output).toContain('- Home');
      }
    });

    it('list_lists empty fallback', async () => {
      execMock.mockResolvedValue({ data: [] });
      const result = await run({ action: 'list_lists' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('没有找到可访问的提醒列表。');
    });

    it('list_reminders formats reminders with completion state', async () => {
      execMock.mockResolvedValue({
        data: [
          { id: 'r1', list: 'Work', title: 'Ship PR', completed: false },
          { id: 'r2', list: 'Work', title: 'Deploy', completed: true },
        ],
      });
      const result = await run({ action: 'list_reminders', list: 'Work' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('提醒事项 (2)');
        expect(result.output).toContain('#r1 [Work] Ship PR');
        expect(result.output).toContain('#r2 [Work] Deploy (completed)');
        expect(result.meta).toMatchObject({
          action: 'list_reminders',
          connector: 'reminders',
          count: 2,
        });
        const artifact = result.meta?.artifact as { kind?: string; metadata?: Record<string, unknown> };
        expect(artifact.kind).toBe('text');
        expect(artifact.metadata?.count).toBe(2);
      }
    });

    it('list_reminders formats remindAtMs when present and 无提醒时间 when null or missing', async () => {
      const remindAtMs = Date.UTC(2026, 10, 9, 1, 0, 0); // 2026-11-09T01:00:00Z
      execMock.mockResolvedValue({
        data: [
          { id: 'r1', list: 'Work', title: 'Dated task', completed: false, remindAtMs },
          { id: 'r2', list: 'Work', title: 'Null task', completed: false, remindAtMs: null },
          { id: 'r3', list: 'Work', title: 'Missing task', completed: true },
        ],
      });
      const result = await run({ action: 'list_reminders', list: 'Work' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain(
          `- #r1 [Work] Dated task | 提醒时间：${formatConnectorTime(remindAtMs)}`,
        );
        expect(result.output).toContain('- #r2 [Work] Null task | 无提醒时间');
        expect(result.output).toContain('- #r3 [Work] Missing task (completed) | 无提醒时间');
      }
    });

    it('list_reminders distinguishes reminders crossing local midnight', async () => {
      vi.stubEnv('TZ', 'Asia/Shanghai');
      try {
        // Asia/Shanghai is UTC+8:
        // 2026-11-09T15:30:00Z -> 2026-11-09 23:30 (UTC+8)
        // 2026-11-09T16:30:00Z -> 2026-11-10 00:30 (UTC+8)
        const beforeMidnightMs = Date.UTC(2026, 10, 9, 15, 30, 0);
        const afterMidnightMs = Date.UTC(2026, 10, 9, 16, 30, 0);
        execMock.mockResolvedValue({
          data: [
            { id: 'm1', list: 'Reminders', title: 'Late night', completed: false, remindAtMs: beforeMidnightMs },
            { id: 'm2', list: 'Reminders', title: 'Early morning', completed: false, remindAtMs: afterMidnightMs },
          ],
        });
        const result = await run({ action: 'list_reminders' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.output).toContain('- #m1 [Reminders] Late night | 提醒时间：2026-11-09 23:30 (UTC+8)');
          expect(result.output).toContain('- #m2 [Reminders] Early morning | 提醒时间：2026-11-10 00:30 (UTC+8)');
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('list_reminders prints date and offset in non-UTC local timezones (Asia/Shanghai and America/Los_Angeles)', async () => {
      const instantMs = Date.UTC(2026, 10, 10, 2, 15, 0); // 2026-11-10T02:15:00Z
      execMock.mockResolvedValue({
        data: [
          { id: 'tz1', list: 'Inbox', title: 'Cross-zone check', completed: false, remindAtMs: instantMs },
        ],
      });

      vi.stubEnv('TZ', 'Asia/Shanghai');
      try {
        const shanghai = await run({ action: 'list_reminders' });
        expect(shanghai.ok).toBe(true);
        if (shanghai.ok) {
          expect(shanghai.output).toContain('- #tz1 [Inbox] Cross-zone check | 提醒时间：2026-11-10 10:15 (UTC+8)');
        }
      } finally {
        vi.unstubAllEnvs();
      }

      vi.stubEnv('TZ', 'America/Los_Angeles');
      try {
        const la = await run({ action: 'list_reminders' });
        expect(la.ok).toBe(true);
        if (la.ok) {
          expect(la.output).toContain('- #tz1 [Inbox] Cross-zone check | 提醒时间：2026-11-09 18:15 (UTC-8)');
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('list_reminders empty fallback', async () => {
      execMock.mockResolvedValue({ data: [] });
      const result = await run({ action: 'list_reminders' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('没有找到匹配的提醒。');
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      execMock.mockResolvedValue({ data: [] });
      const onProgress = vi.fn();
      await run({ action: 'list_lists' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
