import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: state.language } }) }),
}));
vi.mock('../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../src/host/services', async () => ({
  notificationService: (await import('../../../src/host/services/infra/notificationService')).notificationService,
  getSessionManager: () => ({
    getSession: async (sessionId: string) => ({ id: sessionId, title: 'Weekly research' }),
  }),
}));
vi.mock('../../../src/host/services/roleAssets/wakeRunGuard', () => ({ isRoleWakeRunActive: () => false }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: state.info, warn: state.warn, error: vi.fn() }),
}));

import {
  getBackgroundTaskManager,
  resetBackgroundTaskManager,
} from '../../../src/host/session/backgroundTaskManager';
import { notificationService } from '../../../src/host/services/infra/notificationService';
import { settleBackgroundOnTaskComplete } from '../../../src/host/task/backgroundTaskTerminal';

const COMPLETE_AT_MS = 233_000;
const BACKGROUND_AT_MS = 20_000;

function latestBody(): string {
  const body = notificationService.getRecentNotifications().at(-1)?.body;
  expect(body).toBeDefined();
  console.info(`notification body locale=${state.language}: ${JSON.stringify(body)}`);
  return body as string;
}

async function moveToBackground(sessionId: string): Promise<void> {
  vi.setSystemTime(0);
  vi.advanceTimersByTime(BACKGROUND_AT_MS);
  expect(await getBackgroundTaskManager().moveToBackground(sessionId)).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
  state.language = 'zh';
  state.info.mockClear();
  state.warn.mockClear();
  resetBackgroundTaskManager();
  notificationService.clearRecentNotifications();
});

afterEach(() => {
  notificationService.clearRecentNotifications();
  resetBackgroundTaskManager();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('task completion notification duration', () => {
  it.each(['zh', 'en'] as const)('background completion uses the whole run duration in %s', async (language) => {
    state.language = language;
    await moveToBackground(`background-complete-${language}`);
    vi.setSystemTime(COMPLETE_AT_MS);

    await settleBackgroundOnTaskComplete(`background-complete-${language}`, `background-complete-${language}`, {
      summary: 'Weekly report ready',
      duration: COMPLETE_AT_MS,
      toolsUsed: [],
    });

    expect(latestBody()).toContain(language === 'zh' ? '耗时: 3 分 53 秒' : 'Duration: 3 min 53 sec');
    expect(getBackgroundTaskManager().getAllTasks()[0]).toMatchObject({
      startedAt: BACKGROUND_AT_MS,
      backgroundedAt: BACKGROUND_AT_MS,
      status: 'completed',
    });
    expect(state.info).toHaveBeenCalledWith('Background task completed', {
      sessionId: `background-complete-${language}`,
      message: 'Weekly report ready',
    });
  });

  it.each(['zh', 'en'] as const)('background failure uses the supplied whole run duration in %s', async (language) => {
    state.language = language;
    const sessionId = `background-failure-${language}`;
    await moveToBackground(sessionId);
    vi.setSystemTime(COMPLETE_AT_MS);

    await getBackgroundTaskManager().markFailed(sessionId, 'Provider stopped', COMPLETE_AT_MS);

    expect(latestBody()).toContain(language === 'zh' ? '耗时: 3 分 53 秒' : 'Duration: 3 min 53 sec');
  });

  it.each(['zh', 'en'] as const)('foreground completion without a duration omits the duration line in %s', async (language) => {
    state.language = language;

    await settleBackgroundOnTaskComplete(`foreground-${language}`, `foreground-${language}`, {
      summary: 'Weekly report ready',
      toolsUsed: [],
    });

    const body = latestBody();
    expect(body).toBe('Weekly report ready');
    expect(body).not.toMatch(/耗时|Duration|不到 1 秒|under 1 sec/);
  });

  it.each(['zh', 'en'] as const)('background failure without a duration omits the duration line in %s', async (language) => {
    state.language = language;
    const sessionId = `unknown-failure-${language}`;
    await moveToBackground(sessionId);
    vi.setSystemTime(COMPLETE_AT_MS);

    await getBackgroundTaskManager().markFailed(sessionId, 'Provider stopped');

    const body = latestBody();
    expect(body).not.toMatch(/耗时|Duration|不到 1 秒|under 1 sec/);
  });

  it.each([Number.NaN, 0, -1])('invalid foreground duration %s omits the duration line', async (duration) => {
    await settleBackgroundOnTaskComplete('invalid-duration', 'invalid-duration', {
      summary: 'Weekly report ready',
      duration,
      toolsUsed: [],
    });

    expect(latestBody()).toBe('Weekly report ready');
  });

  it('keeps a real measured sub-second duration', async () => {
    await settleBackgroundOnTaskComplete('sub-second', 'sub-second', {
      summary: 'Weekly report ready',
      duration: 500,
      toolsUsed: [],
    });

    expect(latestBody()).toContain('耗时: 不到 1 秒');
  });
});
