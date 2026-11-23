// N-FIX-CRON-START-ORCHESTRATOR-NOT-READY：启动期补跑的 cron agent 运行先等运行时就绪，再建会话。
// 真 TaskManager 单例 + 真 executeCronAgentAction；只有会话创建与 orchestrator 被脚本化。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAction, CronJobDefinition } from '../../../src/shared/contract/cron';
import { CRON_GUARDRAILS } from '../../../src/shared/constants';
import { classifyCronFailure } from '../../../src/shared/utils/cronFailureClassification';
import {
  CRON_RUNTIME_NOT_READY_MESSAGE_EN,
  isCronRuntimeNotReadyError,
} from '../../../src/shared/utils/cronRuntimeNotReady';

const state = vi.hoisted(() => ({
  createSession: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
vi.mock('../../../src/host/cron/cronAgentSession', () => ({
  createCronAgentSession: state.createSession,
}));
vi.mock('../../../src/host/cron/cronAgentRoleContext', () => ({ buildCronAgentRunOptions: async () => ({}) }));
vi.mock('../../../src/host/cron/cronConnectorLost', () => ({
  precheckLostCliConnectors: () => [],
  recordCronConnectorLost: async () => undefined,
  scanLostMcpConnectors: () => [],
}));

import { executeCronAgentAction } from '../../../src/host/cron/cronAgentAction';
import { getTaskManager, initTaskManager, resetTaskManager } from '../../../src/host/task/TaskManager';

const action: AgentAction = { type: 'agent', agentType: 'default', prompt: 'summarize notes.txt' };
const definition: CronJobDefinition = {
  id: 'job-runtime-ready',
  runsOn: 'local',
  name: 'Notes summary',
  scheduleType: 'every',
  schedule: { type: 'every', interval: 1, unit: 'minutes' },
  action,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};
const host = {
  loadJob: () => definition,
  updateJob: vi.fn(async () => undefined),
  deliverCronResult: vi.fn(async () => undefined),
  recordSessionId: vi.fn(async () => undefined),
};

function initializeRuntime() {
  getTaskManager().initialize({
    configService: {} as never,
    onAgentEvent: () => undefined,
  });
}

// 预热 executeCronAgentAction 里的动态 import('../task')：之后它只走微任务，假时钟下的「未建会话」断言才真有区分力。
beforeAll(async () => {
  await import('../../../src/host/task');
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetTaskManager();
  initTaskManager();
  state.createSession.mockResolvedValue({ id: 'cron-session-1', workingDirectory: undefined });
  state.sendMessage.mockResolvedValue(undefined);
  vi.spyOn(getTaskManager(), 'getOrCreateCurrentOrchestrator').mockReturnValue({
    setExecutionTopology: vi.fn(),
    sendMessage: state.sendMessage,
    getMessages: () => [{ id: 'a1', role: 'assistant', content: 'done', timestamp: 2 }],
  } as never);
});

afterEach(() => {
  resetTaskManager();
  vi.useRealTimers();
});

describe('executeCronAgentAction 等待运行时就绪', () => {
  it('(a) 未就绪时不建会话，50ms 后 initialize() 才开跑并完成', async () => {
    const run = executeCronAgentAction(host, definition, action, 'exec-1');
    await vi.advanceTimersByTimeAsync(49);
    expect(state.createSession).not.toHaveBeenCalled();
    initializeRuntime();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(state.createSession).toHaveBeenCalledTimes(1);
    expect(state.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('(b) 一直不就绪：到上限抛固定句、归新分类、不留孤儿会话', async () => {
    const run = executeCronAgentAction(host, definition, action, 'exec-2');
    const settled = run.then(() => null, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(CRON_GUARDRAILS.RUNTIME_READY_WAIT_MS);
    const error = await settled;
    expect(error?.message).toBe(CRON_RUNTIME_NOT_READY_MESSAGE_EN);
    expect(isCronRuntimeNotReadyError(error!.message)).toBe(true);
    expect(classifyCronFailure(error!.message).kind).toBe('runtime_starting');
    expect(error!.message).not.toMatch(/orchestrator|TaskManager/i);
    expect(state.createSession).not.toHaveBeenCalled();
    expect(host.recordSessionId).not.toHaveBeenCalled();
  });

  it('(c) 已就绪：不加等待，同一轮微任务内就建会话', async () => {
    initializeRuntime();
    const run = executeCronAgentAction(host, definition, action, 'exec-3');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.createSession).toHaveBeenCalledTimes(1);
    await run;
  });
});
