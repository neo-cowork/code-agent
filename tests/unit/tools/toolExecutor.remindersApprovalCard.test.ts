// 提醒改 / 删的批准卡补标题：走生产入口 ToolExecutor.execute。
// 提醒连接器仍走 AppleScript，不是 EventKit。这里把 runAppleScript 换成假桥，
// 和日历单测把 EventKit 桥换成假桥是同一层；查到的标题只进卡片，不改派发参数。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  runAppleScript: vi.fn(),
}));
vi.mock('../../../src/host/connectors/native/osascript', async (orig) => ({
  ...(await orig<object>()),
  runAppleScript: bridge.runAppleScript,
}));
vi.mock('../../../src/host/connectors', async (orig) => {
  const { remindersConnector } = await import('../../../src/host/connectors/native/reminders');
  return {
    ...(await orig<object>()),
    getConnectorRegistry: () => ({ get: (id: string) => (id === 'reminders' ? remindersConnector : undefined) }),
  };
});
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
import { resetRemindersConnectorReadiness } from '../../../src/host/connectors/native/reminders';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

const REMINDER_LINE = 'rem-opaque-91|工作|交电费|false||2026-11-19T20:00:00';

function makeExecutor() {
  const requestPermission = vi.fn().mockResolvedValue({ approved: true, approvalSource: 'user' });
  return { requestPermission, executor: new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' }) };
}

beforeEach(() => {
  resetDecisionHistory();
  resetRemindersConnectorReadiness();
  bridge.runAppleScript.mockReset();
  bridge.runAppleScript.mockResolvedValue(REMINDER_LINE);
  for (const m of [resolverState.getDefinition, resolverState.execute, ...Object.values(ledgerState)]) m.mockReset();
  resolverState.getDefinition.mockImplementation((name: string) => ({
    name, description: name, inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: true, permissionLevel: 'write',
  }));
  resolverState.execute.mockResolvedValue({ success: true, result: 'ran' });
});

describe('ToolExecutor: reminder update/delete approval card', () => {
  it('update asks once, keeps reminder_id, and shows the looked-up title', async () => {
    const params = { list: '工作', reminder_id: 'rem-opaque-91', remind_at_ms: Date.parse('2026-11-19T20:00:00') };
    const original = { ...params };
    const { requestPermission, executor } = makeExecutor();
    await executor.execute('reminders_update', params, { sessionId: 's-reminder-update' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(bridge.runAppleScript).toHaveBeenCalledTimes(1);
    const details = requestPermission.mock.calls[0][0].details;
    expect(details.title).toBe('交电费');
    expect(details.reminder_id).toBe('rem-opaque-91');
    expect(details.remind_at_ms).toBe(params.remind_at_ms);
    expect(JSON.stringify(details.preview)).not.toMatch(/Reminder ID|rem-opaque-91/);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    expect(resolverState.execute.mock.calls[0][1]).toEqual(original);
    expect(params).toEqual(original);
  });

  it('delete asks once and puts the looked-up title and time on the generic preview only', async () => {
    const params = { list: '工作', reminder_id: 'rem-opaque-91' };
    const original = { ...params };
    const { requestPermission, executor } = makeExecutor();
    await executor.execute('reminders_delete', params, { sessionId: 's-reminder-delete' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(bridge.runAppleScript).toHaveBeenCalledTimes(1);
    const details = requestPermission.mock.calls[0][0].details;
    expect(details.reminder_id).toBe('rem-opaque-91');
    expect(details.title).toBe('交电费');
    expect(typeof details.remind_at_ms).toBe('number');
    expect(details.preview.diff).toContain('List: 工作');
    expect(details.preview.diff).toContain('Title: 交电费');
    expect(details.preview.diff).toContain('Remind At:');
    expect(details.preview.diff).not.toMatch(/Reminder ID|rem-opaque-91/);
    expect(resolverState.execute.mock.calls[0][1]).toEqual(original);
    expect(params).toEqual(original);
  });

  it('a model-supplied title wins over the looked-up title', async () => {
    const params = { list: '工作', reminder_id: 'rem-opaque-91', title: '模型标题' };
    const { requestPermission, executor } = makeExecutor();
    await executor.execute('reminders_update', params, { sessionId: 's-reminder-model-title' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.title).toBe('模型标题');
    expect(resolverState.execute.mock.calls[0][1]).toEqual(params);

    const deleteRun = makeExecutor();
    await deleteRun.executor.execute('reminders_delete', params, { sessionId: 's-reminder-model-title-delete' });
    const diff = deleteRun.requestPermission.mock.calls[0][0].details.preview.diff as string;
    expect(diff).toContain('Title: 模型标题');
    expect(diff).not.toContain('交电费');
    expect(diff).not.toContain('rem-opaque-91');
    expect(deleteRun.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('lookup failure still asks once, with no title and no id row', async () => {
    bridge.runAppleScript.mockRejectedValue(new Error('Reminders is not authorized'));
    const params = { list: '工作', reminder_id: 'rem-opaque-91' };
    const { requestPermission, executor } = makeExecutor();
    await executor.execute('reminders_delete', params, { sessionId: 's-reminder-lookup-fail' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const details = requestPermission.mock.calls[0][0].details;
    expect(details.title).toBeUndefined();
    expect(details.preview.diff).not.toMatch(/Reminder ID|Title:|rem-opaque-91/);
    expect(details.preview.diff).toContain('List: 工作');
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    expect(resolverState.execute.mock.calls[0][1]).toEqual(params);
  });
});
