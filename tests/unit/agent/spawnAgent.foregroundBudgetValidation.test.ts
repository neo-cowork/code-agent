import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUBAGENT_EXECUTION_TIMEOUTS } from '../../../src/shared/constants';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

const harness = vi.hoisted(() => ({ execute: vi.fn(), release: vi.fn(), register: vi.fn() }));

vi.mock('../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({ execute: harness.execute }),
}));
vi.mock('../../../src/host/agent/spawnGuard', () => ({
  getSpawnGuard: () => ({
    getMaxDepth: () => 5,
    checkDepth: () => true,
    acquireSlot: async () => ({ release: harness.release }),
    register: harness.register,
    getDisabledTools: () => [],
    getReadonlyDisabledTools: () => [],
    getRunningCount: () => 1,
    onComplete: vi.fn(),
  }),
}));
vi.mock('../../../src/host/agent/agentWorktree', () => ({
  cleanupAgentWorktree: vi.fn(),
  cleanupOrphanedWorktrees: async () => undefined,
  discardAgentWorktree: vi.fn(),
  resolveAgentWorktreeIsolation: async () => 'none',
}));
vi.mock('../../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({ getModeForSession: () => 'development' }),
}));
vi.mock('../../../src/host/services/infra/fileOwnershipRegistry', () => ({
  bindFileOwnershipReleaseHook: vi.fn(),
}));

// Keep foreground budget resolution, validation, and racing on the production path.
import { executeSpawnAgent } from '../../../src/host/agent/multiagentTools/spawnAgent';

const context = {
  sessionId: 'wait-validation',
  workspace: '/tmp',
  cwd: '/tmp',
  modelConfig: { provider: 'test', model: 'test-model' },
  permission: { request: async () => true },
  events: { emit: () => undefined },
} as unknown as SubagentExecutionContext;
const task = { task: 'Read notes.txt and draft three key points', customPrompt: 'Summarize the supplied notes.' };
const limit = SUBAGENT_EXECUTION_TIMEOUTS.ROLE_EXECUTION_MINIMUM;

describe('executeSpawnAgent foreground wait argument validation', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([limit, limit + 300_000])('rejects %i ms as invalid arguments before starting a child', async (wait) => {
    const result = await executeSpawnAgent({ ...task, foregroundBlockingBudgetMs: wait }, context);
    expect(result).toEqual({
      success: false,
      error: `foregroundBlockingBudgetMs must be less than role execution timeout (${wait} >= ${limit})`,
      metadata: { failureCode: 'invalid-arguments', foregroundBlockingBudgetMs: wait, roleExecutionTimeout: limit },
    });
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.register).not.toHaveBeenCalled();
  });

  it('accepts a wait immediately below the limit and executes the child', async () => {
    harness.execute.mockResolvedValue({ success: true, output: 'Three key points', toolsUsed: ['Read'], iterations: 1 });
    const result = await executeSpawnAgent({ ...task, foregroundBlockingBudgetMs: limit - 1 }, context);
    expect(result.success).toBe(true);
    expect(result.metadata?.failureCode).toBeUndefined();
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(harness.register).toHaveBeenCalledOnce();
  });
});
