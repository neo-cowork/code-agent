import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentAction,
  CronJobAction,
  CronJobDefinition,
  CronJobExecution,
} from '../../../src/shared/contract/cron';
import { getBudgetService } from '../../../src/host/services/core/budgetService';
import { cronDisableReasonForFailure } from '../../../src/host/cron/cronFailurePolicy';

const dbState = vi.hoisted(() => ({
  savedRows: [] as unknown[][],
}));

const automationState = vi.hoisted(() => ({
  recordCreated: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
  getBySourceRef: vi.fn(() => null),
  upsert: vi.fn(),
}));

const warn = vi.hoisted(() => vi.fn());
const notifyTaskComplete = vi.hoisted(() => vi.fn());

const agentState = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getMessages: vi.fn(),
  setExecutionTopology: vi.fn(),
  cancel: vi.fn(async () => undefined),
  setWorkingDirectory: vi.fn(),
  cleanup: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    appendUsageRecord: vi.fn(),
    getDb: () => ({
      prepare: () => ({
        run: (...args: unknown[]) => {
          dbState.savedRows.push(args);
          return { changes: 1, lastInsertRowid: 0 };
        },
        all: () => [],
        get: () => undefined,
      }),
      transaction: (fn: () => void) => fn,
    }),
  }),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => automationState,
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({
      ui: { language: 'zh' },
      model: {
        provider: 'openai',
        model: 'gpt-test',
        temperature: 0.2,
      },
    }),
  }),
}));

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete },
}));

vi.mock('../../../src/host/services/wake/wakeService', () => ({
  getWakeService: () => ({
    onJobCompleted: vi.fn(async () => undefined),
    onEvent: vi.fn(async () => undefined),
  }),
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(),
    getSettings: () => ({
      ui: { language: 'zh' },
      model: {
        provider: 'openai',
        model: 'gpt-test',
        temperature: 0.2,
      },
    }),
  }),
  getSessionManager: () => ({
    getCurrentSessionId: () => null,
    getSession: vi.fn(async () => null),
    createSession: agentState.createSession,
  }),
}));

vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => ({
      sendMessage: agentState.sendMessage,
      getMessages: agentState.getMessages,
      setExecutionTopology: agentState.setExecutionTopology,
      cancel: agentState.cancel,
    }),
    setWorkingDirectory: agentState.setWorkingDirectory,
    cleanup: agentState.cleanup,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

import { CronService } from '../../../src/host/cron/cronService';

interface CronServiceHarness {
  jobs: Map<string, { definition: CronJobDefinition }>;
  executeAction(
    definition: CronJobDefinition,
    action: CronJobAction,
    timeout?: number,
    executionId?: string,
    eventPayloadBlock?: string,
  ): Promise<unknown>;
  triggerJob(jobId: string): Promise<CronJobExecution | null>;
  getJob(jobId: string): CronJobDefinition | null;
}

const ZERO_PRICED_WARNING = 'Run budget cap cannot trigger on a zero-priced model';

function makeDefinition(context?: Record<string, unknown>): CronJobDefinition {
  const action: AgentAction = {
    type: 'agent',
    agentType: 'default',
    prompt: '检查网页',
    ...(context ? { context } : {}),
  };
  return {
    id: 'job-agent-snapshot',
    runsOn: 'local',
    name: '网页更新提醒',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'days' },
    action,
    enabled: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeMailEventDefinition(maxRunBudget?: number): CronJobDefinition {
  return {
    id: '1ac5883b',
    runsOn: 'local',
    name: 'new mail to todo',
    scheduleType: 'event',
    schedule: {
      type: 'event',
      source: 'connector',
      connector: 'mail',
      accountId: 'iCloud',
      eventName: 'message',
    },
    action: {
      type: 'agent',
      agentType: 'default',
      prompt: '把新邮件整理成待办',
    },
    ...(maxRunBudget !== undefined ? { maxRunBudget } : {}),
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.savedRows = [];
  getBudgetService().manualReset();
  agentState.sendMessage.mockResolvedValue('agent-result');
  agentState.getMessages.mockReturnValue([]);
  agentState.createSession.mockResolvedValue({
    id: 'cron-session-1',
    workingDirectory: undefined,
    modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
  });
});

function cappedJob(maxRunBudget: number): CronJobDefinition {
  return { ...makeDefinition(), maxRunBudget };
}

async function run(definition: CronJobDefinition) {
  const service = new CronService() as unknown as CronServiceHarness;
  service.jobs.set(definition.id, { definition });
  return service.executeAction(definition, definition.action, 1000, 'exec-flat-fee');
}

async function runMailEventJob(definition: CronJobDefinition): Promise<{
  service: CronServiceHarness;
  execution: CronJobExecution;
}> {
  const service = new CronService() as unknown as CronServiceHarness;
  service.jobs.set(definition.id, { definition });
  const execution = await service.triggerJob(definition.id);
  if (!execution) throw new Error('Expected execution');
  return { service, execution };
}

const warnedZeroPriced = () =>
  warn.mock.calls.some(([message]) => message === ZERO_PRICED_WARNING || String(message).includes('zero-priced'));

describe('cron agent run: 包月模型上的预算上限', () => {
  it('包月模型 + maxRunBudget>0：warn 一次并带 job/model/cap/原因', async () => {
    await run(cappedJob(0.5));
    const calls = warn.mock.calls.filter(([message]) => String(message).includes('zero-priced'));
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      jobId: 'job-agent-snapshot',
      model: 'mimo-v2.6-flash',
      maxRunBudget: 0.5,
      reason: 'cap cannot trigger on a zero-priced model',
    });
  });

  it('glm-5.3 按量计价：不 warn', async () => {
    agentState.createSession.mockResolvedValue({
      id: 'cron-session-1', workingDirectory: undefined,
      modelConfig: { provider: 'zhipu', model: 'glm-5.3' },
    });
    await run(cappedJob(0.5));
    expect(warnedZeroPriced()).toBe(false);
  });

  it('包月模型但没设上限：不 warn', async () => {
    await run(makeDefinition() as CronJobDefinition);
    expect(warnedZeroPriced()).toBe(false);
  });
});

describe('event/connector/mail 自动化：真实价表记账下的按量硬顶 vs 包月仅告警', () => {
  it('Case A/① (pay-per-use stop): 经真实 getBudgetService().recordUsage 查 MODEL_PRICING_PER_1M 超出 $0.50 后硬停并带既有状态与原因', async () => {
    const provider = 'zhipu';
    const model = 'glm-5.3';
    agentState.createSession.mockResolvedValue({
      id: 'cron-session-payg',
      workingDirectory: undefined,
      modelConfig: { provider, model },
    });
    let callsAfterExceed = 0;
    // glm-5.3 在 MODEL_PRICING_PER_1M 中 input=0.05, output=0.05 ($/1M)：
    // 6M in + 6M out = $0.30 + $0.30 = $0.6000 > $0.50 cap
    agentState.sendMessage.mockImplementation(async () => {
      getBudgetService().recordUsage({
        provider,
        model,
        inputTokens: 6_000_000,
        outputTokens: 6_000_000,
        timestamp: 1_700_000_000_000,
        sessionId: 'cron-session-payg',
        source: 'provider',
      });
      callsAfterExceed += 1;
      return 'unreachable';
    });

    const definition = makeMailEventDefinition(0.5);
    const service = new CronService() as unknown as CronServiceHarness;
    service.jobs.set(definition.id, { definition });

    // 1) 直接验证 CronService.executeAction -> executeCronAgentAction -> runWithCronJobBudget 抛错文本
    await expect(
      service.executeAction(definition, definition.action, 1000, 'exec-payg-action'),
    ).rejects.toThrow('Cron job run exceeded its $0.50 budget limit (spent $0.6000).');
    expect(callsAfterExceed).toBe(0);

    // 2) 验证完整执行记录状态与停用原因（triggerJob -> executeJob -> executeAction -> executeCronAgentAction）
    const { service: jobService, execution } = await runMailEventJob(makeMailEventDefinition(0.5));
    expect(execution.status).toBe('failed');
    expect(execution.error).toBe(
      'Cron job run exceeded its $0.50 budget limit (spent $0.6000).\n'
      + '成本超限：单 case 实际成本 $0.600000 超过上限 $0.500000',
    );
    expect(cronDisableReasonForFailure(execution.error)).toBe('budget');
    expect(execution.cost).toBeCloseTo(0.6, 6);
    expect(jobService.getJob(definition.id)?.enabled).toBe(false);
    expect(notifyTaskComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: '1ac5883b',
        succeeded: false,
        summary: expect.stringContaining('超过了你设的单次预算上限 $0.50，任务已自动停用'),
      }),
      { force: true },
    );
  });

  it('Case A/② (pay-per-use no zero-priced warning): 按量模型触发 $0.50 硬顶时不记录 zero-priced 预算告警', async () => {
    const provider = 'zhipu';
    const model = 'glm-5.3';
    agentState.createSession.mockResolvedValue({
      id: 'cron-session-payg-nowarn',
      workingDirectory: undefined,
      modelConfig: { provider, model },
    });
    agentState.sendMessage.mockImplementation(async () => {
      getBudgetService().recordUsage({
        provider,
        model,
        inputTokens: 6_000_000,
        outputTokens: 6_000_000,
        timestamp: 1_700_000_000_000,
        sessionId: 'cron-session-payg-nowarn',
        source: 'provider',
      });
      return 'unreachable';
    });

    const { execution } = await runMailEventJob(makeMailEventDefinition(0.5));
    expect(execution.status).toBe('failed');
    expect(warn.mock.calls.filter(([msg]) => msg === ZERO_PRICED_WARNING)).toHaveLength(0);
    expect(warnedZeroPriced()).toBe(false);
  });

  it('Case B (zero-priced): 同款 event/connector/mail + cap 0.5 在包月模型上大用量仍 completed，warn 恰好一次且含三字段', async () => {
    const provider = 'xiaomi';
    const model = 'mimo-v2.6-flash';
    agentState.createSession.mockResolvedValue({
      id: 'cron-session-zero',
      workingDirectory: undefined,
      modelConfig: { provider, model },
    });
    agentState.sendMessage.mockImplementation(async () => {
      getBudgetService().recordUsage({
        provider,
        model,
        inputTokens: 50_000_000,
        outputTokens: 50_000_000,
        timestamp: 1_700_000_000_000,
        sessionId: 'cron-session-zero',
        source: 'provider',
      });
      return undefined;
    });
    agentState.getMessages.mockReturnValue([
      { id: 'assistant-final', role: 'assistant', content: '已整理 1 封邮件到待办', timestamp: 2 },
    ]);

    const { service, execution } = await runMailEventJob(makeMailEventDefinition(0.5));
    expect(execution.status).toBe('completed');
    expect(execution.error).toBeUndefined();
    expect(service.getJob('1ac5883b')?.enabled).toBe(true);

    const zeroWarnCalls = warn.mock.calls.filter(([msg]) => msg === ZERO_PRICED_WARNING);
    expect(zeroWarnCalls).toHaveLength(1);
    expect(zeroWarnCalls[0][1]).toMatchObject({
      jobId: '1ac5883b',
      model: 'mimo-v2.6-flash',
      maxRunBudget: 0.5,
      reason: 'cap cannot trigger on a zero-priced model',
    });
  });

  it('Case C (control): 同款 event/connector/mail + 包月模型未设 maxRunBudget 时不告警且正常完成', async () => {
    const provider = 'xiaomi';
    const model = 'mimo-v2.6-flash';
    agentState.createSession.mockResolvedValue({
      id: 'cron-session-control',
      workingDirectory: undefined,
      modelConfig: { provider, model },
    });
    agentState.sendMessage.mockImplementation(async () => {
      getBudgetService().recordUsage({
        provider,
        model,
        inputTokens: 10_000_000,
        outputTokens: 10_000_000,
        timestamp: 1_700_000_000_000,
        sessionId: 'cron-session-control',
        source: 'provider',
      });
      return undefined;
    });

    const { execution } = await runMailEventJob(makeMailEventDefinition(undefined));
    expect(execution.status).toBe('completed');
    expect(warn.mock.calls.filter(([msg]) => msg === ZERO_PRICED_WARNING)).toHaveLength(0);
    expect(warnedZeroPriced()).toBe(false);
  });
});
