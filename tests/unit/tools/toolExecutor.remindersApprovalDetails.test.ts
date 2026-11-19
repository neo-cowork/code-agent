// 提醒改 / 删的批准卡只带查到的标题和时间，执行参数保持模型原样。
// 走生产入口 ToolExecutor.execute + 假 reminders 连接器。Evidence class: hermetic-protocol.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  mode: 'found' as 'found' | 'missing' | 'boom',
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
    const params = { list: 'Personal', reminder_id: OPAQUE };
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
    const missingResult = await missing.executor.execute('reminders_update', { list: 'Personal', reminder_id: OPAQUE }, { sessionId: 's-update-missing' });
    expect(missing.requestPermission).toHaveBeenCalledTimes(0);
    expect(missingResult.success).toBe(false);
    expect(missingResult.error).toContain('list_reminders');

    store.mode = 'boom';
    const { requestPermission, executor } = makeExecutor();
    await executor.execute('reminders_update', { list: 'Personal', reminder_id: OPAQUE }, { sessionId: 's-update-boom' });
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
