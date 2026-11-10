// ============================================================================
// Detached sub-agents must not keep the parent's composer stall clock alive.
// Foreground children still bump it. Driven through executeSpawnAgent so the
// detached marker is whatever spawn_agent really hands the executor.
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  executorExecute: vi.fn(),
  guardRegister: vi.fn(),
  guardAcquireSlot: vi.fn(),
  raceForegroundBlockingBudget: vi.fn(),
}));

vi.mock('../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({ execute: harness.executorExecute }),
}));

vi.mock('../../../src/host/agent/spawnGuard', () => ({
  getSpawnGuard: () => ({
    getMaxDepth: () => 5,
    checkDepth: () => true,
    acquireSlot: harness.guardAcquireSlot,
    register: harness.guardRegister,
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

vi.mock('../../../src/host/agent/backgroundSubagentRegistry', () => ({
  getBackgroundSubagentRegistry: () => ({ adopt: vi.fn(), register: vi.fn() }),
}));

vi.mock('../../../src/host/agent/multiagentTools/spawnAgentForegroundBackground', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/agent/multiagentTools/spawnAgentForegroundBackground')>()),
  publishBackgroundSubagentVisibility: vi.fn(),
  raceForegroundBlockingBudget: harness.raceForegroundBlockingBudget,
  resolveForegroundBlockingBudgetMs: () => 600_000,
  validateForegroundBlockingBudget: vi.fn(),
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
import { clearStreamProgress, streamProgressOf } from '../../../src/host/agent/stallObserver';
import { createSubagentTurnObservability } from '../../../src/host/agent/subagentTurnTrace';
import type { SubagentEventPort, SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

const sessionId = 'session-detached-stall';

function makeContext(): SubagentExecutionContext {
  return {
    runId: 'run-detached-stall',
    sessionId,
    workspace: '/tmp',
    cwd: '/tmp',
    modelConfig: { provider: 'test', model: 'test-model' },
    resolver: undefined,
    permission: { request: async () => true },
    events: { emit: () => undefined },
    abortSignal: new AbortController().signal,
    currentToolCallId: 'tool-detached-stall',
  } as unknown as SubagentExecutionContext;
}

function capturedChildEvents(): SubagentEventPort {
  const context = harness.executorExecute.mock.calls[0]?.[0]?.context as SubagentExecutionContext;
  return context.events;
}

async function childToolStepBumpsParent(events: SubagentEventPort): Promise<boolean> {
  const observability = createSubagentTurnObservability({
    sessionId,
    identity: { agentId: 'agent_child', runId: 'run-detached-stall', parentToolUseId: 'tool-detached-stall' },
    events,
    workingDirectory: process.cwd(),
    warn: () => {},
  });
  const before = streamProgressOf(sessionId);
  await observability.recordToolResult(
    { id: `step-${before}`, name: 'Read', arguments: { file_path: 'README.md' } },
    { success: true, output: 'ok' },
    5,
  );
  return streamProgressOf(sessionId) > before;
}

describe('detached spawn_agent children and the parent stall clock', () => {
  afterEach(() => {
    clearStreamProgress(sessionId);
    harness.executorExecute.mockReset();
    harness.guardRegister.mockReset();
    harness.guardAcquireSlot.mockReset();
    harness.raceForegroundBlockingBudget.mockReset();
  });

  it('foreground child still bumps the parent progress', async () => {
    harness.executorExecute.mockReturnValue(new Promise(() => undefined));
    harness.guardAcquireSlot.mockResolvedValue({ release: vi.fn() });
    harness.raceForegroundBlockingBudget.mockResolvedValue({
      kind: 'result',
      result: { success: true, output: 'done', iterations: 1, toolsUsed: [] },
    });
    await executeSpawnAgent({ task: '前台任务', customPrompt: '你是前台代理' }, makeContext());
    expect(await childToolStepBumpsParent(capturedChildEvents())).toBe(true);
  });

  it('waitForCompletion:false child tool steps do not bump the parent progress', async () => {
    harness.executorExecute.mockReturnValue(new Promise(() => undefined));
    harness.guardAcquireSlot.mockResolvedValue({ release: vi.fn() });
    await executeSpawnAgent({ task: '后台任务', customPrompt: '你是后台代理', waitForCompletion: false }, makeContext());
    expect(await childToolStepBumpsParent(capturedChildEvents())).toBe(false);
  });

  it('foreground child bumps before adoption and stops bumping once adopted after the blocking budget', async () => {
    harness.executorExecute.mockReturnValue(new Promise(() => undefined));
    harness.guardAcquireSlot.mockResolvedValue({ release: vi.fn() });
    let release: (value: { kind: 'timeout' }) => void = () => {};
    harness.raceForegroundBlockingBudget.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const pending = executeSpawnAgent({ task: '前台长任务', customPrompt: '你是前台代理' }, makeContext());
    await vi.waitFor(() => expect(harness.executorExecute).toHaveBeenCalledOnce());
    const events = capturedChildEvents();

    expect(await childToolStepBumpsParent(events)).toBe(true);
    release({ kind: 'timeout' });
    await pending;
    expect(await childToolStepBumpsParent(events)).toBe(false);
  });
});
