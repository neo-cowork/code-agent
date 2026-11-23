import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentAction,
  CronJobAction,
  CronJobDefinition,
  CronJobExecution,
} from '../../../src/shared/contract/cron';
import { getBudgetService } from '../../../src/host/services/core/budgetService';

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
    waitUntilReady: async () => true,
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

const wakeState = vi.hoisted(() => ({ wakeRole: vi.fn(), getSession: vi.fn() }));
vi.mock('../../../src/host/services/roleAssets/roleProactivity', () => ({ wakeRole: wakeState.wakeRole }));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: wakeState.getSession }),
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

import { CronService } from '../../../src/host/cron/cronService';

interface Harness {
  jobs: Map<string, { definition: CronJobDefinition }>;
  triggerJob(jobId: string): Promise<CronJobExecution | null>;
}

function definitionFor(action: CronJobAction): CronJobDefinition {
  return {
    id: 'job-flat-fee', runsOn: 'local', name: '每天总结文件夹', scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'days' }, action, enabled: false, createdAt: 1, updatedAt: 1,
  };
}

const agentAction: AgentAction = { type: 'agent', agentType: 'default', prompt: '把这个文件夹里的文件总结成一份简短笔记' };

async function runJob(action: CronJobAction): Promise<CronJobExecution> {
  const definition = definitionFor(action);
  const service = new CronService() as unknown as Harness;
  service.jobs.set(definition.id, { definition });
  const execution = await service.triggerJob(definition.id);
  if (!execution) throw new Error('Expected execution');
  return execution;
}

function useModel(provider: string, model: string): void {
  agentState.createSession.mockResolvedValue({
    id: 'cron-session-1', workingDirectory: undefined, modelConfig: { provider, model },
  });
}

function recordUsage(provider: string, model: string, tokens: number): void {
  getBudgetService().recordUsage({
    provider, model, inputTokens: tokens, outputTokens: tokens,
    timestamp: 1_700_000_000_000, sessionId: 'cron-session-1', source: 'provider',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.savedRows = [];
  getBudgetService().manualReset();
  agentState.sendMessage.mockResolvedValue('done');
  agentState.getMessages.mockReturnValue([
    { id: 'a1', role: 'assistant', content: '笔记已整理好', timestamp: 2 },
  ]);
});

describe('cron run flat-fee marker (N-FIX-CRON-SUBSCRIPTION-COST-ALWAYS-UNRECORDED)', () => {
  it('flat-fee model, successful agent run: flatFee set, cost stays unset, row carries flat_fee=1', async () => {
    useModel('xiaomi', 'mimo-v2.6-flash');
    agentState.sendMessage.mockImplementation(async () => { recordUsage('xiaomi', 'mimo-v2.6-flash', 1_000_000); });
    const execution = await runJob(agentAction);
    expect(execution.status).toBe('completed');
    expect(execution.flatFee).toBe(true);
    expect(execution.cost).toBeUndefined();
    const lastRow = dbState.savedRows.filter((args) => args[0] === execution.id).at(-1);
    expect(lastRow?.at(-2)).toBe(1);
  });

  it('flat-fee model, run fails after the session exists: flatFee still set', async () => {
    useModel('xiaomi', 'mimo-v2.6-flash');
    agentState.sendMessage.mockRejectedValue(new Error('upstream exploded'));
    const execution = await runJob(agentAction);
    expect(execution.status).toBe('failed');
    expect(execution.sessionId).toBe('cron-session-1');
    expect(execution.flatFee).toBe(true);
    expect(execution.cost).toBeUndefined();
  });

  it('priced model with real cost: dollars kept, no marker', async () => {
    useModel('zhipu', 'glm-5.3');
    agentState.sendMessage.mockImplementation(async () => { recordUsage('zhipu', 'glm-5.3', 6_000_000); });
    const execution = await runJob(agentAction);
    expect(execution.cost).toBeGreaterThan(0);
    expect(execution.flatFee).toBeUndefined();
  });

  it('priced model with no recorded usage: neither cost nor marker (stays "not fully recorded")', async () => {
    useModel('zhipu', 'glm-5.3');
    const execution = await runJob(agentAction);
    expect(execution.sessionId).toBe('cron-session-1');
    expect(execution.cost).toBeUndefined();
    expect(execution.flatFee).toBeUndefined();
  });

  it('role-wake on a flat-fee model: marker comes from the wake session model', async () => {
    wakeState.wakeRole.mockResolvedValue({ roleId: 'role-a', trigger: 'cadence', status: 'completed', decision: 'silence', sessionId: 'wake-s1' });
    wakeState.getSession.mockResolvedValue({ id: 'wake-s1', modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' } });
    const execution = await runJob({ type: 'role-wake', roleId: 'role-a' } as CronJobAction);
    expect(execution.flatFee).toBe(true);
    expect(execution.cost).toBeUndefined();
  });

  it('role-wake on a priced model without usage: no marker', async () => {
    wakeState.wakeRole.mockResolvedValue({ roleId: 'role-a', trigger: 'cadence', status: 'completed', decision: 'silence', sessionId: 'wake-s2' });
    wakeState.getSession.mockResolvedValue({ id: 'wake-s2', modelConfig: { provider: 'zhipu', model: 'glm-5.3' } });
    const execution = await runJob({ type: 'role-wake', roleId: 'role-a' } as CronJobAction);
    expect(execution.flatFee).toBeUndefined();
  });
});
