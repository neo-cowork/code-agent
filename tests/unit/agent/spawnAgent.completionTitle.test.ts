import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ execute: vi.fn(), race: vi.fn() }));

vi.mock('../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({ execute: harness.execute }),
}));
vi.mock('../../../src/host/agent/agentWorktree', () => ({
  cleanupAgentWorktree: vi.fn(),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(undefined),
  discardAgentWorktree: vi.fn(),
  resolveAgentWorktreeIsolation: vi.fn().mockResolvedValue('none'),
}));
vi.mock('../../../src/host/agent/multiagentTools/spawnAgentForegroundBackground', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/agent/multiagentTools/spawnAgentForegroundBackground')>()),
  raceForegroundBlockingBudget: harness.race,
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

import { executeSpawnAgent } from '../../../src/host/agent/multiagentTools/spawnAgent';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import { getBackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { formatSystemReminderForCompletions } from '../../../src/host/agent/subagentCompletionNotification';
import type { SubagentExecutionContext, SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';

const sessionId = 'session-completion-title';

function context(): SubagentExecutionContext {
  return {
    runId: 'run-completion-title', sessionId, workspace: '/tmp', cwd: '/tmp',
    modelConfig: { provider: 'test', model: 'test-model' },
    permission: { request: async () => true }, events: { emit: () => undefined },
    abortSignal: new AbortController().signal, suppressBackgroundSubagentIdleWake: true,
  } as unknown as SubagentExecutionContext;
}

describe('background completion title sources', () => {
  beforeEach(() => {
    resetSpawnGuard();
    harness.execute.mockReset();
    harness.race.mockReset();
  });

  afterEach(() => {
    resetSpawnGuard();
    getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId });
  });

  describe.each(['detached', 'adopted'] as const)('%s explore completion', (mode) => {
    it.each([undefined, ' 主题核对 ', '   '])('uses the task or explicit name rather than the role display name (name=%s)', async (name) => {
      let finish!: (result: SubagentResult) => void;
      const pending = new Promise<SubagentResult>((resolve) => { finish = resolve; });
      harness.execute.mockReturnValue(pending);
      harness.race.mockResolvedValue({ kind: 'timeout' });

      const result = await executeSpawnAgent({
        role: 'explore', task: '文档主题统计', ...(name !== undefined ? { name } : {}),
        ...(mode === 'detached' ? { waitForCompletion: false } : { foregroundBlockingBudgetMs: 1 }),
      }, context());
      expect(result.success).toBe(true);
      const execution = harness.execute.mock.calls[0]?.[0] as { context: SubagentExecutionContext; config: { name: string } };
      const agentId = execution.context.agentId!;
      expect(execution.config.name).toBe(name?.trim() || 'Explorer');

      finish({ success: true, output: '产品、客户、运营各 8 份，共 24 份。', iterations: 1, toolsUsed: ['Read'] });
      await pending;
      const registry = getBackgroundSubagentRegistry();
      if (mode === 'adopted') await registry.await(agentId);

      const guard = getSpawnGuard();
      const notifications = guard.drainNotifications();
      const records = registry.drainCompletionNotifications({ sessionId });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).not.toContain('Explorer');
      expect(guard.get(agentId)?.completion?.title).toBe(name?.trim() || '文档主题统计');
      expect(notifications[0]).toContain(`只能使用通知中的标题「${name?.trim() || '文档主题统计'}」`);

      if (mode === 'adopted') {
        expect(records).toHaveLength(1);
        expect(records[0].title).toBe(name?.trim() || '文档主题统计');
        const reminder = formatSystemReminderForCompletions(records);
        expect(reminder).not.toContain('Explorer');
        expect(reminder).toContain(`- ${name?.trim() || '文档主题统计'}: completed`);
      }
    });
  });
});
