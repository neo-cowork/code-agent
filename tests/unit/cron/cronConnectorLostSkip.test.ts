// 核心 CLI 连接器未登录：刷新后跳过（不建会话、不调模型），连跳不记失败、不关任务。
// 探测超时 / 出错 / 没人注册入口则照常跑，不信过期缓存。入口是真 executeCronAgentAction 与 CronService.triggerJob。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAction, CronJobDefinition, CronJobExecution } from '../../../src/shared/contract/cron';
import { CONNECTOR_CARD_TIMEOUTS } from '../../../src/shared/constants/timeouts';
import { CRON_CONNECTOR_LOST } from '../../../src/shared/constants/cronErrors';

const warn = vi.hoisted(() => vi.fn());
const settings = vi.hoisted(() => ({ language: 'zh' }));
const automationState = vi.hoisted(() => ({
  recordCreated: vi.fn(async () => undefined),
  recordEvent: vi.fn<() => Promise<object | undefined>>(),
  getBySourceRef: vi.fn(() => null),
  upsert: vi.fn(),
}));
const agentState = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => 'agent-result'),
  getMessages: vi.fn(() => [] as unknown[]),
  setExecutionTopology: vi.fn(),
  cancel: vi.fn(async () => undefined),
  setWorkingDirectory: vi.fn(),
  cleanup: vi.fn(),
  createSession: vi.fn(async () => ({
    id: 'cron-session-1',
    workingDirectory: undefined,
    modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
  })),
  findLatestExpertThreadSession: vi.fn(async () => ({ id: 'expert-thread-1' })),
  addMessageToSession: vi.fn(async () => undefined),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    appendUsageRecord: vi.fn(),
    getDb: () => ({
      prepare: () => ({
        run: () => ({ changes: 1, lastInsertRowid: 0 }),
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
    getServiceApiKey: () => undefined,
    getSettings: () => ({
      ui: { language: settings.language },
      model: { provider: 'openai', model: 'gpt-test', temperature: 0.2 },
    }),
  }),
}));

vi.mock('../../../src/host/services/wake/wakeService', () => ({
  getWakeService: () => ({
    onJobCompleted: vi.fn(async () => undefined),
    onEvent: vi.fn(async () => undefined),
  }),
}));

vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getServiceApiKey: () => undefined,
    getSettings: () => ({
      ui: { language: 'zh' },
      model: { provider: 'openai', model: 'gpt-test', temperature: 0.2 },
    }),
  }),
  getSessionManager: () => ({
    getCurrentSessionId: () => null,
    getSession: vi.fn(async () => null),
    createSession: agentState.createSession,
    findLatestExpertThreadSession: agentState.findLatestExpertThreadSession,
    addMessageToSession: agentState.addMessageToSession,
  }),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getCurrentSessionId: () => null,
    setCurrentSession: vi.fn(),
    getSession: vi.fn(async () => null),
    createSession: agentState.createSession,
    findLatestExpertThreadSession: agentState.findLatestExpertThreadSession,
    addMessageToSession: agentState.addMessageToSession,
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

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: (roleId: string) => {
    if (roleId === 'feishu-expert') return { connectors: [{ id: 'feishu', level: 'core', reason: '读纪要' }] };
    if (roleId === 'both-expert') {
      return {
        connectors: [
          { id: 'feishu', level: 'core', reason: '读纪要' },
          { id: 'tmeet', level: 'core', reason: '读会议' },
        ],
      };
    }
    if (roleId === 'mail-expert') {
      return {
        connectors: [
          { id: 'mail', level: 'core', reason: '读邮件' },
          { id: 'feishu', level: 'optional', reason: '顺便' },
        ],
      };
    }
    return undefined;
  },
}));

import {
  registerCliConnectorStatusProbeStarter,
  replaceCliConnectorConnectionStatusCache,
} from '../../../src/host/connectors/cli/cliConnectorStatusCache';
import { executeCronAgentAction } from '../../../src/host/cron/cronAgentAction';
import { countTrailingCronFailures } from '../../../src/host/cron/cronFailurePolicy';
import { CronService } from '../../../src/host/cron/cronService';
import { notificationService } from '../../../src/host/services/infra/notificationService';

interface CronServiceHarness {
  jobs: Map<string, { definition: CronJobDefinition }>;
  executions: Map<string, CronJobExecution[]>;
  triggerJob(jobId: string): Promise<CronJobExecution | null>;
  getJob(jobId: string): CronJobDefinition | null;
  getJobExecutions(jobId: string, limit?: number): CronJobExecution[];
}

const host = {
  loadJob: (id: string) => harnessFor(id),
  updateJob: async () => undefined,
  deliverCronResult: async () => undefined,
  recordSessionId: async () => undefined,
};

const jobs = new Map<string, CronJobDefinition>();
function harnessFor(id: string): CronJobDefinition {
  const found = jobs.get(id);
  if (!found) throw new Error(`missing job ${id}`);
  return found;
}

let probeImpl: () => Promise<void> = async () => undefined;
let releaseHang: (() => void) | undefined;
const probeStarts = vi.fn(() => probeImpl());

function definition(id: string, roleId?: string, context?: Record<string, unknown>): CronJobDefinition {
  const action: AgentAction = {
    type: 'agent',
    agentType: 'default',
    prompt: '每天早上把昨天的会议纪要收成一篇短摘要，做完告诉我',
    ...(roleId ? { roleId } : {}),
    ...(context ? { context } : {}),
  };
  const job: CronJobDefinition = {
    id,
    runsOn: 'local',
    name: '早晨会议纪要',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'days' },
    action,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  jobs.set(id, job);
  return job;
}

function actionOf(job: CronJobDefinition): AgentAction {
  if (job.action.type !== 'agent') throw new Error('expected agent action');
  return job.action;
}

function lostFeishu(): void {
  replaceCliConnectorConnectionStatusCache([
    { id: 'feishu', connected: false, lostReason: 'cli_not_logged_in' },
  ]);
}

function serviceFor(job: CronJobDefinition): CronServiceHarness {
  const service = new CronService() as unknown as CronServiceHarness;
  service.jobs.set(job.id, { definition: job });
  return service;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
  settings.language = 'zh';
  notificationService.clearRecentNotifications();
  automationState.recordEvent.mockResolvedValue(undefined);
  jobs.clear();
  probeImpl = async () => undefined;
  releaseHang = undefined;
  agentState.sendMessage.mockResolvedValue('agent-result');
  agentState.getMessages.mockReturnValue([]);
  agentState.createSession.mockResolvedValue({
    id: 'cron-session-1',
    workingDirectory: undefined,
    modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
  });
  agentState.findLatestExpertThreadSession.mockResolvedValue({ id: 'expert-thread-1' });
  registerCliConnectorStatusProbeStarter(() => probeStarts());
});

afterEach(async () => {
  releaseHang?.();
  releaseHang = undefined;
  registerCliConnectorStatusProbeStarter(undefined);
  replaceCliConnectorConnectionStatusCache([]);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.resolve();
  await Promise.resolve();
});

describe('executeCronAgentAction connector-lost skip', () => {
  it('records one dry-run notification for two same-day skips using Feishu', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2031, 8, 1, 8));
    settings.language = 'en';
    automationState.recordEvent.mockResolvedValue({});
    probeImpl = async () => lostFeishu();
    const first = definition('job-same-day-first', 'feishu-expert');
    const second = definition('job-same-day-second', 'feishu-expert');
    await executeCronAgentAction(host, first, actionOf(first), 'exec-same-day-first');
    await executeCronAgentAction(host, second, actionOf(second), 'exec-same-day-second');
    const notifications = notificationService.getRecentNotifications();
    process.stdout.write(`${JSON.stringify(notifications, null, 2)}\n`);
    expect(notifications).toEqual([expect.objectContaining({
      type: 'cron_connector_lost',
      code: CRON_CONNECTOR_LOST,
      sessionId: '',
      title: 'Feishu signed out',
      body: "Today's scheduled task didn't run. Reconnect to resume future runs.",
      delivery: 'dry_run',
    })]);
    expect(automationState.recordEvent).toHaveBeenCalledTimes(1);
  });

  it('records two localized dry-run notifications when two connectors are signed out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2031, 8, 2, 8));
    automationState.recordEvent.mockResolvedValue({});
    probeImpl = async () => {
      replaceCliConnectorConnectionStatusCache([
        { id: 'feishu', connected: false, lostReason: 'cli_not_logged_in' },
        { id: 'tmeet', connected: false, lostReason: 'cli_missing_configuration' },
      ]);
    };
    const job = definition('job-two-notifications', 'both-expert');
    await executeCronAgentAction(host, job, actionOf(job), 'exec-two-notifications');
    const notifications = notificationService.getRecentNotifications();
    process.stdout.write(`${JSON.stringify(notifications, null, 2)}\n`);
    expect(notifications.map(({ title }) => title)).toEqual(['飞书已退出登录', '腾讯会议已退出登录']);
    expect(notifications.map(({ body }) => body)).toEqual(Array(2).fill(
      '今天的定时任务没有运行。重新连接后，任务会按计划继续运行。',
    ));
  });

  it('records one more dry-run notification on the next local day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2031, 8, 3, 23, 59));
    automationState.recordEvent.mockResolvedValue({});
    probeImpl = async () => lostFeishu();
    const job = definition('job-next-day', 'feishu-expert');
    await executeCronAgentAction(host, job, actionOf(job), 'exec-before-midnight');
    expect(notificationService.getRecentNotifications()).toHaveLength(1);
    vi.setSystemTime(new Date(2031, 8, 4, 0, 1));
    await executeCronAgentAction(host, job, actionOf(job), 'exec-after-midnight');
    expect(notificationService.getRecentNotifications()).toHaveLength(2);
  });

  it('dedupes overlapping skips while the first inbox write is pending', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2031, 8, 6, 8));
    probeImpl = async () => lostFeishu();
    const writeStarted = Promise.withResolvers<void>();
    const inboxWrite = Promise.withResolvers<object>();
    automationState.recordEvent.mockImplementation(() => {
      writeStarted.resolve();
      return inboxWrite.promise;
    });
    const first = definition('job-overlap-first', 'feishu-expert');
    const second = definition('job-overlap-second', 'feishu-expert');
    const firstRun = executeCronAgentAction(host, first, actionOf(first), 'exec-overlap-first');
    await writeStarted.promise;
    try {
      await executeCronAgentAction(host, second, actionOf(second), 'exec-overlap-second');
      expect(automationState.recordEvent).toHaveBeenCalledTimes(1);
      expect(notificationService.getRecentNotifications()).toEqual([]);
    } finally {
      inboxWrite.resolve({});
      await firstRun;
    }
    expect(notificationService.getRecentNotifications()).toHaveLength(1);
  });
  it('executeCronAgentAction skips before creating a session when the refreshed probe reports a core CLI connector signed out', async () => {
    probeImpl = async () => {
      lostFeishu();
    };
    const job = definition('job-skip', 'feishu-expert');
    const skipped = await executeCronAgentAction(host, job, actionOf(job), 'exec-skip');
    expect(skipped).toEqual({ skipped: true, status: 'skipped', skipReason: 'connector_lost:feishu' });
    expect(agentState.createSession).not.toHaveBeenCalled();
    expect(agentState.sendMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Cron run skipped because a core CLI connector is signed out',
      expect.objectContaining({
        jobId: 'job-skip',
        roleId: 'feishu-expert',
        connectorIds: ['feishu'],
        skipReason: 'connector_lost:feishu',
      }),
    );
    expect(automationState.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventId: expect.stringMatching(/^connector_lost:feishu:\d{4}-\d{2}-\d{2}$/),
    }));
    expect(notificationService.getRecentNotifications()).toEqual([]);
  });

  it('两个核心 CLI 都未登录时 skipReason 按探测顺序用逗号拼 id', async () => {
    probeImpl = async () => {
      replaceCliConnectorConnectionStatusCache([
        { id: 'feishu', connected: false, lostReason: 'cli_not_logged_in' },
        { id: 'tmeet', connected: false, lostReason: 'cli_missing_configuration' },
      ]);
    };
    const job = definition('job-both', 'both-expert');
    const skipped = await executeCronAgentAction(host, job, actionOf(job), 'exec-both');
    expect(skipped).toEqual({ skipped: true, status: 'skipped', skipReason: 'connector_lost:feishu,tmeet' });
    expect(agentState.createSession).not.toHaveBeenCalled();
    expect(agentState.sendMessage).not.toHaveBeenCalled();
  });

  it('没有核心 CLI 连接器的角色不探测，照常建会话并调模型', async () => {
    lostFeishu();
    const mail = definition('job-mail', 'mail-expert');
    await executeCronAgentAction(host, mail, actionOf(mail), 'exec-mail');
    const plain = definition('job-plain');
    await executeCronAgentAction(host, plain, actionOf(plain), 'exec-plain');
    expect(probeStarts).not.toHaveBeenCalled();
    expect(agentState.createSession).toHaveBeenCalledTimes(2);
    expect(agentState.sendMessage).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((call) => call[0]);
    expect(messages).not.toContain('Cron run skipped because a core CLI connector is signed out');
    expect(messages).not.toContain('CLI connector status probe did not refresh; cron run continues');
  });

  it('探测超时则忽略过期的未登录缓存，照常跑并留下可区分的 warn', async () => {
    vi.useFakeTimers();
    lostFeishu();
    let hang!: Promise<void>;
    probeImpl = () => {
      hang = new Promise<void>((resolve) => {
        releaseHang = resolve;
      });
      return hang;
    };
    const job = definition('job-timeout', 'feishu-expert');
    const pending = executeCronAgentAction(host, job, actionOf(job), 'exec-timeout');
    await vi.advanceTimersByTimeAsync(CONNECTOR_CARD_TIMEOUTS.CLI_STATUS_PROBE_WAIT_MS);
    const result = await pending;
    expect(agentState.createSession).toHaveBeenCalledTimes(1);
    expect(agentState.sendMessage).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ sessionId: 'cron-session-1' }));
    expect(result).not.toEqual(expect.objectContaining({ skipped: true }));
    expect(warn).toHaveBeenCalledWith(
      'CLI connector status probe did not refresh; cron run continues',
      expect.objectContaining({ probeOutcome: 'timeout', waitMs: CONNECTOR_CARD_TIMEOUTS.CLI_STATUS_PROBE_WAIT_MS }),
    );
  });

  it('探测入口没注册时不根据过期缓存跳过', async () => {
    registerCliConnectorStatusProbeStarter(undefined);
    lostFeishu();
    const job = definition('job-unregistered', 'feishu-expert');
    await executeCronAgentAction(host, job, actionOf(job), 'exec-unregistered');
    expect(probeStarts).not.toHaveBeenCalled();
    expect(agentState.sendMessage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'CLI connector status probe did not refresh; cron run continues',
      expect.objectContaining({ probeOutcome: 'not-registered', waitMs: CONNECTOR_CARD_TIMEOUTS.CLI_STATUS_PROBE_WAIT_MS }),
    );
  });

  it('探测失败时照常跑，warn 带上失败原因', async () => {
    lostFeishu();
    probeImpl = async () => {
      throw new Error('probe blew up');
    };
    const job = definition('job-error', 'feishu-expert');
    await executeCronAgentAction(host, job, actionOf(job), 'exec-error');
    expect(agentState.sendMessage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'CLI connector status probe did not refresh; cron run continues',
      expect.objectContaining({ probeOutcome: 'error', probeError: 'probe blew up' }),
    );
  });

  it('一次性任务在核心 CLI 未登录时仍建会话并调模型，不返回跳过', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2031, 8, 5, 8));
    automationState.recordEvent.mockResolvedValue({});
    probeImpl = async () => {
      lostFeishu();
    };
    const job = definition('job-at', 'feishu-expert');
    job.scheduleType = 'at';
    job.schedule = { type: 'at', datetime: '2031-09-01T09:00:00' };
    const result = await executeCronAgentAction(host, job, actionOf(job), 'exec-at');
    expect(result).toEqual(expect.objectContaining({ sessionId: 'cron-session-1' }));
    expect(result).not.toEqual(expect.objectContaining({ status: 'skipped' }));
    expect(agentState.createSession).toHaveBeenCalledTimes(1);
    expect(agentState.sendMessage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'One-time cron run continues despite a signed-out core CLI connector',
      expect.objectContaining({ jobId: 'job-at', connectorIds: ['feishu'] }),
    );
    expect(automationState.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventId: expect.stringMatching(/^connector_lost:feishu:\d{4}-\d{2}-\d{2}$/),
    }));
    expect(notificationService.getRecentNotifications()).toEqual([]);
    const recurring = definition('job-after-at', 'feishu-expert');
    await executeCronAgentAction(host, recurring, actionOf(recurring), 'exec-after-at');
    expect(notificationService.getRecentNotifications()).toEqual([]);
  });

  it('心跳窗外先返回，不探测连接器', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 1, 3, 0, 0));
    lostFeishu();
    probeImpl = async () => {
      lostFeishu();
    };
    const job = definition('job-heartbeat', 'feishu-expert', {
      heartbeatTask: true,
      activeHours: '09:00-17:00',
    });
    const skipped = await executeCronAgentAction(host, job, actionOf(job), 'exec-heartbeat');
    expect(skipped).toEqual({ skipped: true, reason: 'outside_active_hours' });
    expect(probeStarts).not.toHaveBeenCalled();
    expect(agentState.createSession).not.toHaveBeenCalled();
    expect(agentState.sendMessage).not.toHaveBeenCalled();
  });

  it('运行后工具结果里的 MCP 401 仍记 connector_lost 收件箱，且这次运行已经调了模型', async () => {
    automationState.recordEvent.mockResolvedValue({});
    agentState.getMessages.mockReturnValue([{
      role: 'tool',
      toolResults: [{
        toolCallId: 't1',
        success: false,
        error: 'Unauthorized',
        metadata: { mcpAuthorizationRequired: true, server: 'notion' },
      }],
    }] as never);
    const job = definition('job-mcp');
    await executeCronAgentAction(host, job, actionOf(job), 'exec-mcp');
    expect(probeStarts).not.toHaveBeenCalled();
    expect(agentState.sendMessage).toHaveBeenCalledTimes(1);
    expect(automationState.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventId: expect.stringMatching(/^connector_lost:notion:\d{4}-\d{2}-\d{2}$/),
    }));
    expect(notificationService.getRecentNotifications()).toEqual([]);
  });
});

describe('CronService.triggerJob connector-lost skip', () => {
  it('连续六次断连跳过不消耗运行次数上限，重连后实际运行才用掉最后一次额度', async () => {
    probeImpl = async () => {
      lostFeishu();
    };
    const job = definition('job-streak', 'feishu-expert');
    job.maxRuns = 2;
    job.runCount = 1;
    const service = serviceFor(job);
    service.executions.set(job.id, [{
      id: 'old-fail',
      jobId: job.id,
      runsOn: 'local',
      status: 'failed',
      scheduledAt: 1,
      retryAttempt: 0,
      error: 'boom',
    }]);

    const skipped: CronJobExecution[] = [];
    for (let i = 0; i < 6; i += 1) {
      const execution = await service.triggerJob(job.id);
      if (!execution) throw new Error('expected execution');
      skipped.push(execution);
    }

    expect(skipped).toHaveLength(6);
    for (const execution of skipped) {
      expect(execution.status).toBe('completed');
      expect(execution.sessionId).toBeUndefined();
      expect(execution.result).toEqual({ skipped: true, status: 'skipped', skipReason: 'connector_lost:feishu' });
    }
    expect(countTrailingCronFailures(service.getJobExecutions(job.id, 20))).toBe(0);
    expect(service.getJob(job.id)?.enabled).toBe(true);
    expect(service.getJob(job.id)?.runCount).toBe(1);
    expect(agentState.createSession).not.toHaveBeenCalled();
    expect(agentState.sendMessage).not.toHaveBeenCalled();

    probeImpl = async () => {
      replaceCliConnectorConnectionStatusCache([{ id: 'feishu', connected: true }]);
    };
    const resumed = await service.triggerJob(job.id);
    expect(resumed?.status).toBe('completed');
    expect(resumed?.sessionId).toBe('cron-session-1');
    expect(resumed?.result).toEqual(expect.objectContaining({ sessionId: 'cron-session-1' }));
    expect(resumed?.result).not.toEqual(expect.objectContaining({ skipped: true }));
    expect(agentState.createSession).toHaveBeenCalledTimes(1);
    expect(agentState.sendMessage).toHaveBeenCalledTimes(1);
    expect(service.getJob(job.id)).toMatchObject({
      enabled: false,
      runCount: 2,
      metadata: { disabledReason: 'max_runs_reached' },
    });
  });

  it('首次实际运行失败、重试遇到断连时仍计一次运行', async () => {
    probeImpl = async () => {
      replaceCliConnectorConnectionStatusCache([{ id: 'feishu', connected: true }]);
    };
    agentState.sendMessage.mockImplementationOnce(async () => {
      probeImpl = async () => lostFeishu();
      throw new Error('temporary network error');
    });
    const job = definition('job-retry', 'feishu-expert');
    job.maxRuns = 2;
    job.maxRetries = 1;
    job.retryDelay = 1;
    const service = serviceFor(job);

    const execution = await service.triggerJob(job.id);

    expect(execution).toMatchObject({
      status: 'completed',
      retryAttempt: 1,
      result: { skipped: true, status: 'skipped', skipReason: 'connector_lost:feishu' },
    });
    expect(agentState.sendMessage).toHaveBeenCalledTimes(1);
    expect(service.getJob(job.id)).toMatchObject({ enabled: true, runCount: 1 });
  });

  it('一次性任务未登录时照常跑完并停用，不留下还会继续的跳过', async () => {
    probeImpl = async () => {
      lostFeishu();
    };
    const job = definition('job-at-service', 'feishu-expert');
    job.scheduleType = 'at';
    job.schedule = { type: 'at', datetime: '2031-09-01T09:00:00' };
    const service = serviceFor(job);
    const execution = await service.triggerJob(job.id);
    expect(execution?.status).toBe('completed');
    expect(execution?.sessionId).toBe('cron-session-1');
    expect(execution?.result).toEqual(expect.objectContaining({ sessionId: 'cron-session-1' }));
    expect(execution?.result).not.toEqual(expect.objectContaining({ status: 'skipped' }));
    expect(service.getJob(job.id)?.enabled).toBe(false);
    expect(agentState.createSession).toHaveBeenCalledTimes(1);
  });
});
