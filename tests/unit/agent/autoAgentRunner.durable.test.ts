import { beforeEach, describe, expect, it, vi } from 'vitest';

const coordinatorState = vi.hoisted(() => ({ execute: vi.fn() }));
const factoryState = vi.hoisted(() => ({ create: vi.fn() }));
const durableState = vi.hoisted(() => ({
  start: vi.fn(),
  persist: vi.fn(),
  terminal: vi.fn(),
}));
const loggerState = vi.hoisted(() => ({ warn: vi.fn() }));
const sessionManagerState = vi.hoisted(() => ({ addMessageToSession: vi.fn() }));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: loggerState.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/agent/autoAgentCoordinator', () => ({
  getAutoAgentCoordinator: () => ({ execute: coordinatorState.execute }),
}));
vi.mock('../../../src/host/agent/dynamicAgentFactory', () => ({
  getDynamicAgentFactory: () => ({ create: factoryState.create }),
}));
vi.mock('../../../src/host/agent/agentRequirementsAnalyzer', () => ({
  getAgentRequirementsAnalyzer: () => ({ analyze: vi.fn() }),
}));
vi.mock('../../../src/host/agent/autoAgentDurableRuntime', () => ({
  getAutoAgentDurableRuntime: () => ({ start: durableState.start }),
}));
vi.mock('../../../src/host/telemetry/runTraceContext', () => ({
  getActiveRunTraceContext: () => ({ runId: 'run-parent' }),
}));
vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
}));
vi.mock('../../../src/host/scheduler/TaskDAG', () => ({
  TaskDAG: class { addAgentTask = vi.fn(); },
}));
vi.mock('../../../src/host/scheduler/dagEventBridge', () => ({ sendDAGInitEvent: vi.fn() }));
vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({ name: 'mock-tool-resolver' }),
}));

import { runAutoAgentMode } from '../../../src/host/agent/orchestrator/autoAgentRunner';

function makeTaskListManager() {
  return {
    reset: vi.fn(),
    createTask: vi.fn((input) => ({
      id: `task-${input.subject}`,
      subject: input.subject,
      description: input.description,
    })),
    getState: vi.fn(() => ({ requireApproval: false })),
    waitForApproval: vi.fn(),
    startExecution: vi.fn(),
    completeExecution: vi.fn(),
    failExecution: vi.fn(),
  };
}

function makeDeps() {
  return {
    workingDirectory: '/tmp/project',
    sessionId: 'session-auto-1',
    sourceMessageId: 'message-auto-1',
    taskListManager: makeTaskListManager() as never,
    generateId: () => 'message-1',
    addMessage: vi.fn(),
    sendDAGStatusEvent: vi.fn(),
    runStandardAgentLoop: vi.fn(),
  };
}

function run(deps: ReturnType<typeof makeDeps>, onEvent = vi.fn()) {
  return runAutoAgentMode(
    'do the work',
    'do the work with context',
    { taskType: 'work', executionStrategy: 'sequential', confidence: 0.9 } as never,
    onEvent,
    { provider: 'mock', model: 'mock-model' } as never,
    deps,
    'session-auto-1',
  );
}

describe('runAutoAgentMode durable terminal containment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factoryState.create.mockReturnValue([{
      id: 'agent-worker',
      name: 'Worker',
      role: 'worker',
      systemPrompt: 'do the work',
      taskDescription: 'work',
      tools: ['read_file'],
      maxIterations: 1,
      maxBudget: 1,
      priority: 1,
      canRunParallel: false,
    }]);
    durableState.start.mockResolvedValue({
      runId: 'auto-child',
      persist: durableState.persist,
      terminal: durableState.terminal,
    });
    durableState.persist.mockResolvedValue(undefined);
    durableState.terminal.mockResolvedValue(undefined);
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
    coordinatorState.execute.mockResolvedValue({
      success: true,
      strategy: 'sequential',
      results: [],
      aggregatedOutput: 'completed output',
      totalDuration: 1,
      totalIterations: 1,
      totalCost: 0,
      errors: [],
    });
  });

  it('preserves a successful graph result when durable terminal is fenced', async () => {
    durableState.terminal.mockRejectedValue(new Error('Durable run write fenced by stale owner: auto-child'));
    const deps = makeDeps();

    await expect(run(deps)).resolves.toBeUndefined();

    expect(deps.addMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'completed output' }));
    expect(loggerState.warn).toHaveBeenCalledWith(
      'Auto Agent durable terminal projection failed; preserving successful graph result',
      { runId: 'auto-child', reason: 'fenced', error: 'Durable run write fenced by stale owner: auto-child' },
    );
  });

  it('distinguishes other durable terminal failures without failing a successful graph', async () => {
    durableState.terminal.mockRejectedValue(new Error('disk full'));

    await expect(run(makeDeps())).resolves.toBeUndefined();

    expect(loggerState.warn).toHaveBeenCalledWith(
      'Auto Agent durable terminal projection failed; preserving successful graph result',
      { runId: 'auto-child', reason: 'other', error: 'disk full' },
    );
  });


  it.each([
    { output: '## 主 Agent (综合处理)\n\nSubagent completed without output', success: true, failedChild: false, reason: 'empty_output' },
    { output: '   ', success: true, failedChild: false, reason: 'empty_output' },
    { output: '部分完成的内容', success: false, failedChild: false, reason: 'agent_failed' },
    { output: '部分完成的内容', success: true, failedChild: true, reason: 'agent_failed' },
  ])('signals unavailable report without publishing it: $reason / $output', async ({ output, success, failedChild, reason }) => {
    coordinatorState.execute.mockResolvedValue({
      success, strategy: 'sequential',
      results: failedChild ? [{ agentId: 'failed-child', agentName: 'Worker', status: 'failed', result: { success: false, output: 'retry exhausted' } }] : [],
      aggregatedOutput: output, totalDuration: 1, totalIterations: 1, totalCost: 0, errors: [],
    });
    const deps = makeDeps();
    const onEvent = vi.fn();

    await expect(run(deps, onEvent)).resolves.toBeUndefined();

    expect(deps.addMessage).not.toHaveBeenCalled();
    expect(sessionManagerState.addMessageToSession).not.toHaveBeenCalled();
    expect(onEvent.mock.calls.filter(([event]) => event.type === 'message')).toEqual([]);
    expect(onEvent).toHaveBeenCalledWith({
      type: 'error',
      data: { message: 'AUTO_AGENT_REPORT_UNAVAILABLE', details: { reason } },
    });
    expect(loggerState.warn).toHaveBeenCalledWith('Auto Agent report unavailable', { sessionId: 'session-auto-1', reason });
  });

  it('publishes the usable sections when one child failed and one has real output', async () => {
    coordinatorState.execute.mockResolvedValue({
      success: true, strategy: 'parallel',
      results: [
        { agentId: 'a', agentName: 'Worker', status: 'failed', result: { success: false, output: 'retry exhausted' } },
        { agentId: 'b', agentName: 'Reader', status: 'completed', result: { success: true, output: '已完成的摘要' } },
        { agentId: 'c', agentName: 'Empty', status: 'completed', result: { success: true, output: 'Subagent completed without output' } },
      ],
      aggregatedOutput: '## Worker\n\nretry exhausted\n\n---\n\n## Reader\n\n已完成的摘要\n\n---\n\n## Empty\n\nSubagent completed without output',
      totalDuration: 1, totalIterations: 1, totalCost: 0, errors: [],
    });
    const deps = makeDeps();
    const onEvent = vi.fn();

    await expect(run(deps, onEvent)).resolves.toBeUndefined();

    expect(deps.addMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '## Reader\n\n已完成的摘要' }));
    expect(onEvent.mock.calls.filter(([event]) => event.type === 'error')).toEqual([]);
  });

  it('drops only the placeholder section of an aggregated report without per-agent results', async () => {
    coordinatorState.execute.mockResolvedValue({
      success: true, strategy: 'parallel', results: [],
      aggregatedOutput: '## A\n\n真实内容\n\n---\n\n## B\n\nSubagent completed without output',
      totalDuration: 1, totalIterations: 1, totalCost: 0, errors: [],
    });
    const deps = makeDeps();

    await run(deps);

    expect(deps.addMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '## A\n\n真实内容' }));
  });

  it('still propagates a real graph failure', async () => {
    const failure = new Error('graph execution failed');
    coordinatorState.execute.mockRejectedValue(failure);

    await expect(run(makeDeps())).rejects.toBe(failure);

    expect(durableState.terminal).toHaveBeenCalledWith('failed', 'graph execution failed');
    expect(loggerState.warn).not.toHaveBeenCalledWith(
      'Auto Agent durable terminal projection failed; preserving successful graph result',
      expect.anything(),
    );
  });
});
