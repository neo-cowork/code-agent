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
import { getEventBus, shutdownEventBus } from '../../../src/host/services/eventing/bus';
import type { SwarmEvent } from '../../../src/shared/contract/swarm';
import { executeSpawnAgent } from '../../../src/host/agent/multiagentTools/spawnAgent';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

const CWD = '/Users/someone/notes';
const PREFIX = `[工作目录: ${CWD}] 所有文件路径基于此目录。`;

function context(): SubagentExecutionContext {
  return {
    runId: 'run-workdir-prefix', sessionId: 'session-workdir-prefix', workspace: CWD, cwd: CWD,
    modelConfig: { provider: 'test', model: 'test-model' },
    permission: { request: async () => true }, events: { emit: () => undefined },
    abortSignal: new AbortController().signal, suppressBackgroundSubagentIdleWake: true,
    currentToolCallId: 'tool-call-workdir-prefix',
  } as unknown as SubagentExecutionContext;
}

describe('spawn_agent workdir prefix', () => {
  beforeEach(() => {
    resetSpawnGuard();
    harness.execute.mockReset();
    harness.execute.mockResolvedValue({ success: true, output: 'done', iterations: 1, toolsUsed: [] });
  });
  afterEach(() => resetSpawnGuard());

  it('single: executor prompt keeps the prefix, registered task is clean', async () => {
    const result = await executeSpawnAgent({ role: 'explore', task: '读三份笔记并列出待办' }, context());
    expect(result.success).toBe(true);
    const prompt = (harness.execute.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt.startsWith(`${PREFIX}\n\n读三份笔记并列出待办`)).toBe(true);
    const tasks = getSpawnGuard().list().map((agent) => agent.task);
    expect(tasks).toContain('读三份笔记并列出待办');
    expect(tasks.join('\n')).not.toContain('[工作目录');
  });

  it('parallel: every executor prompt keeps the prefix, swarm display task is clean', async () => {
    const durableDb = new Database(':memory:');
    durableDb.pragma('foreign_keys = ON');
    const durableRepo = new DurableRunRepository(durableDb);
    durableRepo.migrate();
    const kernel = new DurableRunKernel({ stores: durableRepo, ownerId: 'host', processInstanceId: 'workdir-prefix', leaseDurationMs: 60_000 });
    const registry = appRuns.getApplicationRunRegistry();
    registry.configureDurableKernel(kernel);
    configureAgentTeamDurableRuntime(new AgentTeamDurableRuntime(kernel, registry));
    const added: SwarmEvent[] = [];
    const unsubscribe = getEventBus().subscribe('swarm', (event: { data?: unknown }) => {
      const payload = event.data as SwarmEvent | undefined;
      if (payload?.type === 'swarm:agent:added') added.push(payload);
    }) as unknown as () => void;
    try {
      await registry.startDurable({ runId: 'run-workdir-prefix', sessionId: 'session-workdir-prefix', workspace: CWD });
      const result = await executeSpawnAgent({
        parallel: true,
        agents: [
          { role: 'explore', task: '总结 notes.md' },
          { role: 'explore', task: '检查 data.csv' },
        ],
      }, context());
      expect(result.error ?? '').toBe('');
      const prompts = harness.execute.mock.calls.map((call) => (call[0] as { prompt: string }).prompt);
      expect(prompts).toHaveLength(2);
      for (const prompt of prompts) expect(prompt.startsWith(`${PREFIX}\n\n`)).toBe(true);
      expect(prompts.some((p) => p.endsWith('总结 notes.md'))).toBe(true);
      const shown = added.map((e) => (e.data?.agentState as { dispatchedTask?: string } | undefined)?.dispatchedTask);
      expect(shown.sort()).toEqual(['总结 notes.md', '检查 data.csv']);
    } finally {
      unsubscribe();
      configureAgentTeamDurableRuntime(null);
      appRuns.resetApplicationRunRegistryForTests();
      shutdownEventBus();
    }
  }, 30_000);
});
