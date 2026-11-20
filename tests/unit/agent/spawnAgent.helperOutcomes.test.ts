import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock('../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({ execute: harness.execute }),
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

import { configureAgentTeamDurableRuntime, AgentTeamDurableRuntime } from '../../../src/host/agent/agentTeamDurableAdapter';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';
import * as appRuns from '../../../src/host/app/applicationRunRegistry';
import { shutdownEventBus } from '../../../src/host/services/eventing/bus';
import { executeSpawnAgent } from '../../../src/host/agent/multiagentTools/spawnAgent';
import { resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { humanizeToolFailureReason } from '../../../src/renderer/utils/toolExecutionPresentation';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const CWD = '/Users/someone/notes';

function context(): SubagentExecutionContext {
  return {
    runId: 'run-helper-outcomes', sessionId: 'session-helper-outcomes', workspace: CWD, cwd: CWD,
    modelConfig: { provider: 'test', model: 'test-model' },
    permission: { request: async () => true }, events: { emit: () => undefined },
    abortSignal: new AbortController().signal, suppressBackgroundSubagentIdleWake: true,
    currentToolCallId: 'tool-call-helper-outcomes',
  } as unknown as SubagentExecutionContext;
}

describe('spawn_agent parallel: each helper reports its own outcome', () => {
  beforeEach(() => {
    resetSpawnGuard();
    harness.execute.mockReset();
  });
  afterEach(() => resetSpawnGuard());

  it('one helper hits the step limit, the other succeeds', async () => {
    harness.execute.mockImplementation(async (input: { prompt: string }) => (
      input.prompt.includes('做演示稿')
        ? { success: false, output: '', error: 'Max iterations reached', failureCode: 'step-cap-reached', iterations: 20, toolsUsed: [] }
        : { success: true, output: '纪要写好了', iterations: 2, toolsUsed: [] }
    ));
    const durableDb = new Database(':memory:');
    durableDb.pragma('foreign_keys = ON');
    const durableRepo = new DurableRunRepository(durableDb);
    durableRepo.migrate();
    const kernel = new DurableRunKernel({ stores: durableRepo, ownerId: 'host', processInstanceId: 'helper-outcomes', leaseDurationMs: 60_000 });
    const registry = appRuns.getApplicationRunRegistry();
    registry.configureDurableKernel(kernel);
    configureAgentTeamDurableRuntime(new AgentTeamDurableRuntime(kernel, registry));
    try {
      await registry.startDurable({ runId: 'run-helper-outcomes', sessionId: 'session-helper-outcomes', workspace: CWD });
      const args = {
        parallel: true,
        agents: [
          { name: '纪要助手', role: 'explore', task: '整理会议纪要' },
          { name: '演示稿助手', role: 'explore', task: '做演示稿' },
        ],
      };
      const result = await executeSpawnAgent(args, context());
      expect(result.success).toBe(false);
      expect(result.metadata?.helperOutcomes).toEqual([
        { name: '纪要助手', success: true },
        { name: '演示稿助手', success: false, failureCode: 'step-cap-reached' },
      ]);

      const toolCall = { name: 'spawn_agent', result: { toolCallId: 't', success: false, error: result.error, metadata: result.metadata } };
      const row = humanizeToolStep('spawn_agent', args, zh, undefined, 'failed', undefined, { helperOutcomes: result.metadata?.helperOutcomes as never });
      console.info(`ROW zh: ${row}`);
      expect(row).toBe('纪要助手已完成；演示稿助手未完成 — 这次任务做到步数上限，已停下');
      expect(humanizeToolFailureReason(toolCall as never, zh)).toBe('这次任务做到步数上限，已停下');
      expect(humanizeToolFailureReason(toolCall as never, zh)).not.toBe(zh.toolStepHumanize.failureReasonMissing);
      expect(humanizeToolStep('spawn_agent', args, en, undefined, 'failed', undefined, { helperOutcomes: result.metadata?.helperOutcomes as never }))
        .toBe('纪要助手 done; 演示稿助手 not done — This task reached its step limit and stopped'.replace('This task', 'This task'));
      expect(row).not.toMatch(/agent_|explore|step-cap-reached|Max iterations/);
    } finally {
      configureAgentTeamDurableRuntime(null);
      appRuns.resetApplicationRunRegistryForTests();
      shutdownEventBus();
    }
  }, 30_000);
});
