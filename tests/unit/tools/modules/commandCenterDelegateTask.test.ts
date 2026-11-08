import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, ToolContext } from '../../../../src/host/protocol/tools';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/host/services/commandCenter/sessionCommandCenter', () => ({
  getSessionCommandCenter: () => ({ spawn }),
}));

import { executeDelegateTask } from '../../../../src/host/tools/modules/commandCenter/sessionCommandCenter';

const allow = vi.fn().mockResolvedValue({ allow: true }) as CanUseToolFn;
const scope = createWorkspaceScope('delegate-task-test', [{
  sourceId: 'delegate-task-source',
  path: '/tmp/delegate-task-project',
  role: 'primary',
  access: 'read_write',
}]);

function context(): ToolContext {
  return {
    sessionId: 'delegate-task-test-session',
    workspace: scope.primaryRoot,
    workspaceScope: scope,
    workingDir: scope.primaryRoot,
    abortSignal: new AbortController().signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emit: vi.fn(),
  };
}

const args = {
  title: '普通后台任务',
  short_name: '普通',
  lane_key: 'normal-lane',
  submission_key: 'normal-submission',
  prompt: '执行普通后台任务',
};

describe('executeDelegateTask requires_choice copy', () => {
  beforeEach(() => {
    spawn.mockReset();
  });

  it('preserves queue/replace guidance for normal delegations', async () => {
    spawn.mockResolvedValue({
      outcome: 'requires_choice',
      active: [{ shortName: '周报' }, { shortName: '研究' }],
    });

    const result = await executeDelegateTask(args, context(), allow);

    expect(result).toEqual({
      ok: true,
      output: '并发槽已满，任务尚未创建。现在调用 AskUserQuestion，让用户选择“排队”或替换这些活跃任务之一：周报、研究。',
    });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ laneKey: 'normal-lane' }));
  });

  it('uses the concise no-command sentence only for redirected foreground shell work', async () => {
    spawn.mockResolvedValue({
      outcome: 'requires_choice',
      active: [{ shortName: '已有任务' }],
    });

    const result = await executeDelegateTask({
      ...args,
      title: '运行磁盘检查',
      lane_key: 'foreground-shell:run-1',
      submission_key: 'foreground-shell:run-1',
      prompt: '用户请求：检查磁盘占用\n\nCommand to run:\ndu -sh .',
    }, context(), allow);

    expect(result).toEqual({
      ok: true,
      output: '后台任务暂时无法启动，当前并发名额已满；命令没有运行。',
    });
    expect(result.output).not.toContain('AskUserQuestion');
    expect(result.output).not.toContain('终端自行执行');
  });
});
