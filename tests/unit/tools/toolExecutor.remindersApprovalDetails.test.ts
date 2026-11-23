// 提醒改 / 删的批准卡只带查到的标题和时间，执行参数保持模型原样。
// 走生产入口 ToolExecutor.execute + 假 reminders 连接器。Evidence class: hermetic-protocol.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  mode: 'found' as 'found' | 'missing' | 'boom',
  calls: [] as string[],
  item: {
    id: 'x-apple-reminder://opaque-9f3c2a',
    list: 'Personal',
    title: 'pay electricity',
    remindAtMs: 1_763_337_600_000,
  },
}));
vi.mock('../../../src/host/connectors', async (orig) => ({
  ...(await orig<object>()),
  getConnectorRegistry: () => ({
    get: (id: string) => (id === 'reminders' ? {
      execute: async (action: string) => {
        store.calls.push(action);
        if (action !== 'get_reminder') throw new Error(`unexpected reminders action ${action}`);
        if (store.mode === 'missing') throw new Error('Reminders got an error: Can’t get reminder id "x-apple-reminder://opaque-9f3c2a". (-1728)');
        if (store.mode === 'boom') throw new Error('Reminders timed out');
        return { data: store.item };
      },
    } : undefined),
  }),
}));
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
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

const OPAQUE = 'x-apple-reminder://opaque-9f3c2a';

function makeExecutor() {
  const requestPermission = vi.fn().mockResolvedValue({ approved: true, approvalSource: 'user' });
  return { requestPermission, executor: new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' }) };
}

beforeEach(() => {
  resetDecisionHistory();
  store.mode = 'found';
  store.calls.length = 0;
  store.item = {
    id: OPAQUE,
    list: 'Personal',
    title: 'pay electricity',
    remindAtMs: 1_763_337_600_000,
  };
  for (const m of [resolverState.getDefinition, resolverState.execute, ...Object.values(ledgerState)]) m.mockReset();
  resolverState.getDefinition.mockImplementation((name: string) => ({
    name, description: name, inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: true, permissionLevel: 'write',
  }));
  resolverState.execute.mockResolvedValue({ success: true, result: 'ran' });
});

describe('ToolExecutor: reminder update/delete approval details', () => {
  it('update card carries the looked-up title and time, and execute params stay the originals', async () => {
    const params = { list: 'Personal', reminder_id: OPAQUE, completed: true };
    const original = { ...params };
    const { requestPermission, executor } = makeExecutor();
    await executor.execute('reminders_update', params, { sessionId: 's-update' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const details = requestPermission.mock.calls[0][0].details;
    expect(details).toMatchObject({
      list: 'Personal',
      reminder_id: OPAQUE,
      title: 'pay electricity',
      remind_at_ms: 1_763_337_600_000,
      calendarApprovalSnapshotFields: ['title', 'remind_at_ms'],
    });
    expect(resolverState.execute.mock.calls[0][1]).toEqual(original);
    expect(params).toEqual(original);
  });

  it('update omits looked-up keys the model already sent', async () => {
    const params = { list: 'Personal', reminder_id: OPAQUE, remind_at_ms: 1_800_000_000_000 };
    const { requestPermission, executor } = makeExecutor();
    await executor.execute('reminders_update', params, { sessionId: 's-update-friday' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const details = requestPermission.mock.calls[0][0].details;
    expect(details).toMatchObject({
      title: 'pay electricity',
      remind_at_ms: 1_800_000_000_000,
      calendarApprovalSnapshotFields: ['title'],
    });
    expect(resolverState.execute.mock.calls[0][1]).toEqual(params);
  });

  it('delete ignores a model-supplied title and time, and execute params stay the originals', async () => {
    const params = { list: 'Personal', reminder_id: OPAQUE, title: 'wrong', remind_at_ms: 1 };
    const original = { ...params };
    const { requestPermission, executor } = makeExecutor();
    await executor.execute('reminders_delete', params, { sessionId: 's-delete' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const request = requestPermission.mock.calls[0][0];
    expect(request.details).toMatchObject({
      list: 'Personal',
      title: 'pay electricity',
      remind_at_ms: 1_763_337_600_000,
    });
    expect(request.details.title).not.toBe('wrong');
    expect(request.details.remind_at_ms).not.toBe(1);
    expect(request.details.preview.diff).not.toContain('Reminder ID');
    expect(request.details.preview.diff).not.toContain('wrong');
    expect(resolverState.execute.mock.calls[0][1]).toEqual(original);
    expect(params).toEqual(original);
  });

  it('not-found delete returns failure without calling requestPermission', async () => {
    store.mode = 'missing';
    const { requestPermission, executor } = makeExecutor();
    const result = await executor.execute('reminders_delete', { list: 'Personal', reminder_id: OPAQUE }, { sessionId: 's-missing' });
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('list_reminders');
  });

  it('not-found update returns failure without a card; other update lookup failures still ask', async () => {
    store.mode = 'missing';
    const missing = makeExecutor();
    const missingResult = await missing.executor.execute('reminders_update', { list: 'Personal', reminder_id: OPAQUE, completed: true }, { sessionId: 's-update-missing' });
    expect(missing.requestPermission).toHaveBeenCalledTimes(0);
    expect(missingResult.success).toBe(false);
    expect(missingResult.error).toContain('list_reminders');

    store.mode = 'boom';
    const { requestPermission, executor } = makeExecutor();
    await executor.execute('reminders_update', { list: 'Personal', reminder_id: OPAQUE, completed: true }, { sessionId: 's-update-boom' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const details = requestPermission.mock.calls[0][0].details;
    expect(details).not.toHaveProperty('title');
    expect(details).not.toHaveProperty('calendarApprovalSnapshotFields');
  });

  it('any delete lookup failure returns failure without a card', async () => {
    store.mode = 'boom';
    const { requestPermission, executor } = makeExecutor();
    const result = await executor.execute('reminders_delete', { list: 'Personal', reminder_id: OPAQUE, title: 'wrong' }, { sessionId: 's-delete-boom' });
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(result.success).toBe(false);
    expect(result.error).toContain('list_reminders');
    expect(String(result.error)).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('ToolExecutor: reminders_update with no effective change', () => {
  it('unknown time field (remind_at alias) is rejected before any card', async () => {
    const { requestPermission, executor } = makeExecutor();
    const result = await executor.execute(
      'reminders_update',
      { list: 'Personal', reminder_id: OPAQUE, remind_at: '2026-11-22 15:00' },
      { sessionId: 's-alias-time' },
    );
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('INVALID_ARGS');
    expect(result.error).toContain('remind_at_ms');
    expect(String(result.error)).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('bare list+reminder_id (no change field at all) is rejected the same way', async () => {
    const { requestPermission, executor } = makeExecutor();
    const result = await executor.execute('reminders_update', { list: 'Personal', reminder_id: OPAQUE }, { sessionId: 's-bare' });
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('INVALID_ARGS');
    expect(result.error).toContain('remind_at_ms');
  });

  it('completed:false is a real change and still produces one card', async () => {
    const { requestPermission, executor } = makeExecutor();
    await executor.execute('reminders_update', { list: 'Personal', reminder_id: OPAQUE, completed: false }, { sessionId: 's-reopen' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('clear_remind_at:true is a real change and still produces one card', async () => {
    const { requestPermission, executor } = makeExecutor();
    await executor.execute('reminders_update', { list: 'Personal', reminder_id: OPAQUE, clear_remind_at: true }, { sessionId: 's-clear' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('replay: alias call needs 0 cards, corrected remind_at_ms retry needs exactly 1 card', async () => {
    const { requestPermission, executor } = makeExecutor();
    const failed = await executor.execute(
      'reminders_update',
      { list: 'Personal', reminder_id: OPAQUE, remind_at: '2026-11-22 15:00' },
      { sessionId: 's-replay' },
    );
    expect(failed.success).toBe(false);
    expect(failed.metadata?.code).toBe('INVALID_ARGS');
    expect(requestPermission).toHaveBeenCalledTimes(0);

    const corrected = { list: 'Personal', reminder_id: OPAQUE, remind_at_ms: 1_800_000_000_000 };
    await executor.execute('reminders_update', corrected, { sessionId: 's-replay-2' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const details = requestPermission.mock.calls[0][0].details;
    expect(details.remind_at_ms).toBe(1_800_000_000_000);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    expect(resolverState.execute.mock.calls[0][1]).toEqual(corrected);
  });
});

describe('ToolExecutor: reminders_update past remind_at_ms guard', () => {
  const now = new Date('2026-11-20T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('rejects a past remind_at_ms before approval; the connector sees neither get_reminder nor update_reminder', async () => {
    const { requestPermission, executor } = makeExecutor();
    const result = await executor.execute(
      'reminders_update',
      { list: 'Personal', reminder_id: OPAQUE, remind_at_ms: now - 3_600_000 },
      { sessionId: 's-update-past' },
    );
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('REMINDER_TIME_IN_PAST');
    expect(result.error).toContain('The reminder was not changed');
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
  });

  it('still rejects when clear_remind_at is sent together with the past time', async () => {
    const { requestPermission, executor } = makeExecutor();
    const result = await executor.execute(
      'reminders_update',
      { list: 'Personal', reminder_id: OPAQUE, remind_at_ms: now - 3_600_000, clear_remind_at: true },
      { sessionId: 's-update-past-clear' },
    );
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('REMINDER_TIME_IN_PAST');
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(store.calls).toEqual([]);
  });

  it('a remind_at_ms inside the 60s grace window still produces one card', async () => {
    const { requestPermission, executor } = makeExecutor();
    await executor.execute(
      'reminders_update',
      { list: 'Personal', reminder_id: OPAQUE, remind_at_ms: now - 59_000 },
      { sessionId: 's-update-grace' },
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('a future remind_at_ms still produces one card', async () => {
    const { requestPermission, executor } = makeExecutor();
    await executor.execute(
      'reminders_update',
      { list: 'Personal', reminder_id: OPAQUE, remind_at_ms: now + 3_600_000 },
      { sessionId: 's-update-future' },
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('a title-only update is unaffected by the guard', async () => {
    const { requestPermission, executor } = makeExecutor();
    await executor.execute(
      'reminders_update',
      { list: 'Personal', reminder_id: OPAQUE, title: 'renamed' },
      { sessionId: 's-update-title' },
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });
});
