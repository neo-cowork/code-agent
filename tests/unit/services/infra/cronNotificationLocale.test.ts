import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition, CronJobExecution } from '../../../../src/shared/contract/cron';
import { parseScheduledJobName } from '../../../../src/shared/i18n/cronNotificationTitle';
import { CRON_CLOUD_UNAVAILABLE_MESSAGE_EN } from '../../../../src/shared/utils/cronCloudUnavailable';

const language = vi.hoisted(() => ({ value: 'zh' }));

vi.mock('../../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer: vi.fn(),
}));
vi.mock('../../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: language.value } }) }),
}));

const { notificationService } = await import('../../../../src/host/services/infra/notificationService');
const { CronFailureNoticeGate, notifyCronAgentExecution, notifyCronJobDisabled } =
  await import('../../../../src/host/cron/cronFailurePolicy');

const definition = {
  id: 'cron-1',
  name: 'Morning notes',
  maxRuns: 1,
  action: { type: 'agent', agentType: 'default', prompt: 'summarize' },
} as CronJobDefinition;

function execution(status: 'completed' | 'failed', extra: Partial<CronJobExecution> = {}): CronJobExecution {
  return {
    id: `e-${status}`, jobId: definition.id, status, scheduledAt: 0, retryAttempt: 0,
    sessionId: 'session-1', duration: 2_000, ...extra,
  } as CronJobExecution;
}

function titles(): string[] {
  return notificationService.getRecentNotifications().map((entry) => entry.title);
}

describe('scheduled-task notification titles follow ui.language', () => {
  beforeEach(() => {
    process.env.CODE_AGENT_NOTIFICATION_DRY_RUN = '1';
    notificationService.clearRecentNotifications();
  });
  afterEach(() => {
    notificationService.clearRecentNotifications();
    delete process.env.CODE_AGENT_NOTIFICATION_DRY_RUN;
    language.value = 'zh';
  });

  it.each([
    ['zh', '任务完成 - [定时] Morning notes', '任务失败 - [定时] Morning notes'],
    ['en', 'Task completed - [Scheduled] Morning notes', 'Task failed - [Scheduled] Morning notes'],
  ])('%s: notifyCronAgentExecution success + notifyCronJobDisabled', (lang, done, disabled) => {
    language.value = lang;
    notifyCronAgentExecution(definition, execution('completed'), new CronFailureNoticeGate());
    notifyCronJobDisabled(definition, execution('completed'), 'max_runs');
    expect(titles()).toEqual([done, disabled]);
  });

  it('en: cloud-unavailable failure keeps a parseable English host title', () => {
    language.value = 'en';
    notifyCronAgentExecution(
      definition,
      execution('failed', { sessionId: undefined, error: CRON_CLOUD_UNAVAILABLE_MESSAGE_EN }),
      new CronFailureNoticeGate(),
    );
    const [title] = titles();
    expect(title).toBe('Task failed - [Scheduled] Morning notes');
    expect(parseScheduledJobName(title)).toBe('Morning notes');
  });

  it('notifyTaskComplete shell and body lines: zh unchanged, en localized', () => {
    const body = () => notificationService.getRecentNotifications().at(-1)?.body;
    notificationService.notifyTaskComplete(
      { sessionId: 's', sessionTitle: 'T', duration: 1_000, toolsUsed: ['a', 'b'] }, { force: true });
    expect(titles()).toEqual(['任务完成 - T']);
    expect(body()).toBe('使用了 2 个工具 耗时: 1 秒');

    notificationService.clearRecentNotifications();
    language.value = 'en';
    notificationService.notifyTaskComplete(
      { sessionId: 's', sessionTitle: 'T', duration: 65_000, toolsUsed: ['a', 'b'] }, { force: true });
    expect(titles()).toEqual(['Task completed - T']);
    expect(body()).toBe('Used 2 tools Duration: 1 min 5 sec');
  });
});

describe('parseScheduledJobName', () => {
  it.each([
    ['任务失败 - [定时] 整理邮件', '整理邮件'],
    ['Task failed - [Scheduled] Morning notes', 'Morning notes'],
    ['[Scheduled] [Work] weekly report [v2]', '[Work] weekly report [v2]'],
    ['任务完成 - [定时] [日报] 汇总', '[日报] 汇总'],
  ])('%s -> %s', (title, name) => {
    expect(parseScheduledJobName(title)).toBe(name);
  });
  it('returns undefined without the marker', () => {
    expect(parseScheduledJobName('Task failed - something')).toBeUndefined();
  });
});
