import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en', title: '[Schedule] 每晨整理周会纪要' }));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: state.language } }) }),
}));
vi.mock('../../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../../src/host/services', async () => ({
  notificationService: (await import('../../../../src/host/services/infra/notificationService')).notificationService,
  getSessionManager: () => ({ getSession: async () => ({ id: 'cron-session', title: state.title }) }),
}));
vi.mock('../../../../src/host/session/backgroundTaskManager', () => ({
  getBackgroundTaskManager: () => ({ isInBackground: () => false }),
}));
vi.mock('../../../../src/host/services/roleAssets/wakeRunGuard', () => ({ isRoleWakeRunActive: () => false }));

import { notificationService } from '../../../../src/host/services/infra/notificationService';
import { settleBackgroundOnTaskComplete } from '../../../../src/host/task/backgroundTaskTerminal';

afterEach(() => {
  notificationService.clearRecentNotifications();
  vi.unstubAllEnvs();
});

describe('cron completion through the production terminal entry', () => {
  it.each(['zh', 'en'] as const)('renders the stored cron title using notification locale %s', async (language) => {
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
    state.language = language;
    await settleBackgroundOnTaskComplete('cron-session', 'cron-session', { summary: '周会纪要摘要已整理', duration: 500 });
    const title = notificationService.getRecentNotifications().at(-1)?.title;
    expect(title).toBe(language === 'zh' ? '任务完成 - [定时] 每晨整理周会纪要' : 'Task completed - [Schedule] 每晨整理周会纪要');
    console.info(`settleBackgroundOnTaskComplete → notifyTaskComplete locale=${language} title=${title}`);
  });
});
