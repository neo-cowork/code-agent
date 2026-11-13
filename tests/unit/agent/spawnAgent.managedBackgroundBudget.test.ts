// ============================================================================
// run_in_background 子代理跑过前台阻塞预算：不得再走「前台预算→收养」
//
// 回归（PR #3225 ai-review）：后台 lane 已在 BackgroundSubagentRegistry 以 agentId 登记，
// 内层 executeSingleSpawnAgent 若仍竞速前台预算，超时后 adopt 同一 id 会抛
// 'Background subagent already running'，用户收到 Failed to spawn agent，
// 而子代理继续跑、最终结果没有地方落。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../src/host/protocol/tools';

const harness = vi.hoisted(() => ({
  executorExecute: vi.fn(),
}));

vi.mock('../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({ execute: harness.executorExecute }),
}));

vi.mock('../../../src/host/agent/spawnGuard', () => ({
  getSpawnGuard: () => ({
    getMaxDepth: () => 5,
    checkDepth: () => true,
    acquireSlot: async () => ({ release: vi.fn() }),
    register: vi.fn(),
    get: () => undefined,
    getDisabledTools: () => [],
    getReadonlyDisabledTools: () => [],
    getRunningCount: () => 1,
    onComplete: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/agentWorktree', () => ({
  cleanupAgentWorktree: vi.fn(),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(undefined),
  discardAgentWorktree: vi.fn(),
  resolveAgentWorktreeIsolation: vi.fn().mockResolvedValue('none'),
}));

vi.mock('../../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({ getModeForSession: () => 'development' }),
}));

vi.mock('../../../src/host/services/infra/fileOwnershipRegistry', () => ({
  bindFileOwnershipReleaseHook: vi.fn(),
}));

vi.mock('../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => ({ getSessionState: () => ({ status: 'idle' }) }),
}));

import { spawnAgentModule } from '../../../src/host/tools/modules/multiagent/spawnAgent';
import { getBackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { SUBAGENT_EXECUTION_TIMEOUTS } from '../../../src/shared/constants';

const errorSpy = vi.fn();
const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: errorSpy };
const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('run_in_background 子代理超过前台预算', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    harness.executorExecute.mockReset();
  });

  it('不抛 already running、不报失败；原记录收到子代理最终结果', async () => {
    let finish!: (value: unknown) => void;
    harness.executorExecute.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const sessionId = 'sess-managed-budget';
    const ctx = {
      sessionId,
      workingDir: '/tmp/test',
      abortSignal: new AbortController().signal,
      logger,
      emit: () => undefined,
      modelConfig: { provider: 'kimi', model: 'kimi-k2.5' },
      resolver: { getDefinition: vi.fn() },
    } as unknown as ToolContext;

    const handler = await spawnAgentModule.createHandler();
    const started = await handler.execute(
      { role: 'coder', task: '把销售表整理成 10 页演示稿', run_in_background: true },
      ctx,
      allowAll,
    );
    expect(started.ok).toBe(true);

    const registry = getBackgroundSubagentRegistry();
    const ids = registry.listBySession(sessionId).map((h) => h.agentId);
    expect(ids).toHaveLength(1);
    const agentId = ids[0];

    // 子代理跑过前台阻塞预算。
    await vi.advanceTimersByTimeAsync(SUBAGENT_EXECUTION_TIMEOUTS.FOREGROUND_TO_BACKGROUND_BUDGET + 1_000);
    expect(registry.getStatus(agentId)?.status).toBe('running');

    finish({ success: true, output: '演示稿已完成', iterations: 3, toolsUsed: ['Write'], cost: 0, tokensUsed: 10 });
    await vi.advanceTimersByTimeAsync(10);

    const handles = registry.listBySession(sessionId);
    expect(handles).toHaveLength(1);
    expect(handles[0].agentId).toBe(agentId);
    expect(handles[0].status).toBe('completed');
    expect(handles[0].result?.output).toContain('演示稿已完成');

    const notices = registry.drainCompletionNotifications({ sessionId });
    expect(notices).toHaveLength(1);
    expect(notices[0].status).toBe('completed');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/already running|Failed to spawn/);
  });
});
