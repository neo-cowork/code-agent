import { beforeEach, describe, expect, it, vi } from 'vitest';

const toolExecutorState = vi.hoisted(() => ({
  config: undefined as undefined | {
    requestPermission: (request: Record<string, unknown>) => Promise<unknown>;
  },
}));

vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class ToolExecutor {
    constructor(config: typeof toolExecutorState.config) {
      toolExecutorState.config = config;
    }
  },
}));

import { getBackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { formatSystemReminderForCompletions } from '../../../src/host/agent/subagentCompletionNotification';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import { getPermissionModeManager, resetPermissionModeManager, type PermissionMode } from '../../../src/host/permissions/modes';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';

const ok: SubagentResult = { success: true, output: 'HTTP 200', toolsUsed: ['Bash'], iterations: 1 };

/** 在后台 run 内走真实的 requestPermission，随后取回唤醒轮收到的回执文本。 */
async function runHelper(input: {
  sessionId: string;
  agentId: string;
  mode?: PermissionMode;
  permissionResults: unknown[];
  type?: 'command' | 'file_read';
}): Promise<string> {
  const mode = input.mode ?? 'default';
  getPermissionModeManager().setSessionMode(input.sessionId, mode, mode === 'bypassPermissions');
  const registry = getBackgroundSubagentRegistry();
  const request = vi.fn();
  for (const result of input.permissionResults) request.mockResolvedValueOnce(result);
  await registry.await(registry.spawn(async () => {
    createSubagentToolRuntime({
      context: {
        sessionId: input.sessionId,
        cwd: '/tmp/workbench',
        resolver: { getDefinition: vi.fn() },
        permission: { request },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
      } as never,
      sessionId: input.sessionId,
      effectiveMode: mode,
      identity: { agentId: input.agentId, runId: 'run-1' },
      allowedToolNames: new Set(['Bash']),
      checkToolExecution: vi.fn(() => true),
    });
    for (let i = 0; i < Math.max(input.permissionResults.length, 1); i += 1) {
      await toolExecutorState.config!.requestPermission({ type: input.type ?? 'command', tool: 'Bash', details: {} });
    }
    return ok;
  }, { agentId: input.agentId, title: '检查本地页面', completionKind: 'user_visible', sessionId: input.sessionId }));
  const records = registry.drainCompletionNotifications({ sessionId: input.sessionId });
  expect(records).toHaveLength(1);
  return formatSystemReminderForCompletions(records, { delivery: 'wake' });
}

function userApprovalsOf(reminder: string): unknown {
  const json = reminder.slice(reminder.indexOf('{'), reminder.lastIndexOf('}') + 1);
  return JSON.parse(json).user_approvals;
}

describe('后台代理回执带真人审批计数', () => {
  beforeEach(() => {
    toolExecutorState.config = undefined;
    resetPermissionModeManager();
  });

  it('真人点一次允许 → 回执 user_approvals approved=1 denied=0', async () => {
    const reminder = await runHelper({
      sessionId: 's-approve', agentId: 'subagent-bg-a1',
      permissionResults: [{ approved: true, approvalSource: 'user' }],
    });
    expect(reminder).toContain('"user_approvals"');
    expect(userApprovalsOf(reminder)).toEqual({ approved: 1, denied: 0 });
    expect(reminder).toContain('没有这个字段就不要对审批做任何说法');
  });

  it('先拒绝再重试：各自的回执只记自己这次 run 的决定，无人为决定的 run 不带该字段', async () => {
    const denied = await runHelper({
      sessionId: 's-retry', agentId: 'subagent-bg-d1',
      permissionResults: [{ approved: false, denialSource: 'user' }],
    });
    expect(userApprovalsOf(denied)).toEqual({ approved: 0, denied: 1 });

    const retried = await runHelper({
      sessionId: 's-retry', agentId: 'subagent-bg-d2',
      permissionResults: [{ approved: true, approvalSource: 'user' }],
    });
    expect(userApprovalsOf(retried)).toEqual({ approved: 1, denied: 0 });

    const untouched = await runHelper({ sessionId: 's-retry', agentId: 'subagent-bg-d3', mode: 'bypassPermissions', permissionResults: [] });
    expect(untouched).not.toContain('user_approvals"');
  });

  it.each([
    ['按模式自动放行', { mode: 'bypassPermissions' as const, results: [] as unknown[] }],
    ['机器批准（session-allowlist）', { mode: 'default' as const, results: [{ approved: true, approvalSource: 'session-allowlist' }] }],
    ['超时拒绝', { mode: 'default' as const, results: [{ approved: false, denialSource: 'timeout' }] }],
    ['会话取消', { mode: 'default' as const, results: [{ approved: false, denialSource: 'cancelled' }] }],
    ['来源不明的裸 false', { mode: 'default' as const, results: [false] }],
  ])('机器决定不计数：%s', async (_name, { mode, results }) => {
    const reminder = await runHelper({
      sessionId: `s-machine-${_name}`, agentId: `subagent-bg-m-${_name}`, mode, permissionResults: results,
    });
    expect(reminder).not.toContain('user_approvals"');
  });
});
