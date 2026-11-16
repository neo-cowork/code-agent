import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ language: 'zh', broadcast: vi.fn() }));
vi.mock('../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  broadcastToRenderer: state.broadcast,
}));
vi.mock('../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: () => fake, logger: fake, default: fake };
});
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: state.language } }) }),
}));

vi.mock('../../../src/host/services', async () => ({
  getSessionManager: () => ({}),
  notificationService: (await import('../../../src/host/services/infra/notificationService')).notificationService,
}));
import { notificationService } from '../../../src/host/services/infra/notificationService';
import { persistTaskManagerEvent } from '../../../src/host/task/taskManagerEventPersistence';
import { MessageDeltaAccumulator } from '../../../src/host/protocol/messageDeltaAccumulator';

beforeEach(() => { state.broadcast.mockClear(); notificationService.clearRecentNotifications(); });
afterEach(() => { vi.restoreAllMocks(); notificationService.clearRecentNotifications(); });

describe('desktop approval banner through taskManagerEventPersistence', () => {
  it.each([
    ['en', 'Approval needed', 'Export spreadsheet'],
    ['zh', '需要授权', '导出表格'],
  ])('ui.language=%s names the spreadsheet action', async (language, title, action) => {
    state.language = language;
    const notify = vi.spyOn(notificationService, 'notifyNeedsInput');
    await persistTaskManagerEvent({
      turnStateBySession: new Map(), backgroundPermissionOwners: new Map(),
      backgroundRunTerminalErrors: new Map(), messageDeltaAccumulator: new MessageDeltaAccumulator(),
    }, 'desktop-session', {
      type: 'permission_request',
      data: { id: 'desktop-request', type: 'file_write', tool: 'excel_generate', details: {}, timestamp: 1 },
    });
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'desktop-session', title,
      body: `${title}${language === 'en' ? ': ' : '：'}${action}`, dedupeKey: 'desktop-request', tool: 'excel_generate',
    });
    expect(state.broadcast).toHaveBeenCalledOnce();
    const payload = notify.mock.calls[0][0];
    expect(payload.body).not.toContain('excel_generate');
    if (language === 'en') expect(payload.title + payload.body).not.toMatch(/[\u3400-\u9fff]/);
  });
});
