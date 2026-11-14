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
import { getEventBus, shutdownEventBus } from '../../../src/host/services/eventing/bus';
import type { SwarmEvent } from '../../../src/shared/contract/swarm';

const errorSpy = vi.fn();
const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: errorSpy };
const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('managed background spawn lifecycle ownership', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { shutdownEventBus(); vi.useRealTimers(); harness.executorExecute.mockReset(); });

  it('publishes one start and awaits the child when run_in_background and waitForCompletion=false are both supplied', async () => {
    let finish!: (value: unknown) => void;
    harness.executorExecute.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const sessionId = 'session-managed-lifecycle';
    const events: SwarmEvent[] = [];
    getEventBus().subscribe<SwarmEvent>('swarm', (event) => { events.push(event.data); });
    const ctx = { sessionId, workingDir: '/tmp/test', abortSignal: new AbortController().signal,
      logger, emit: () => undefined, modelConfig: { provider: 'kimi', model: 'kimi-k2.5' },
      resolver: { getDefinition: vi.fn() } } as unknown as ToolContext;
    const handler = await spawnAgentModule.createHandler();
    const started = await handler.execute({ role: 'coder', task: '把销售表整理成 10 页演示稿',
      run_in_background: true, waitForCompletion: false }, ctx, allowAll);
    expect(started.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(65);
    const registry = getBackgroundSubagentRegistry();
    const handles = registry.listBySession(sessionId);
    expect(handles).toHaveLength(1);
    expect(events.filter((event) => event.type === 'swarm:started')).toHaveLength(1);
    expect(registry.getStatus(handles[0].agentId)?.status).toBe('running');
    expect(events.filter((event) => event.type === 'swarm:completed')).toHaveLength(0);

    finish({ success: true, output: '演示稿已完成', iterations: 3, toolsUsed: ['Write'] });
    await vi.advanceTimersByTimeAsync(10);
    expect(registry.getStatus(handles[0].agentId)?.status).toBe('completed');
    expect(events.filter((event) => event.type === 'swarm:completed')).toHaveLength(1);
    expect(registry.drainCompletionNotifications({ sessionId })).toHaveLength(1);
  });
});
