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

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getSession: () => null, getRecentMessages: () => [] }),
}));
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { DEFAULT_SETTINGS } from '../../../src/host/services/core/configDefaults';
import { notificationService } from '../../../src/host/services/infra/notificationService';
import { PARKED_APPROVAL_ENTRY_PATH } from '../../../src/shared/parkedApprovalLocation';

beforeEach(() => {
  resetPermissionModeManager(); state.broadcast.mockClear(); notificationService.clearRecentNotifications();
});
afterEach(() => {
  resetPermissionModeManager(); vi.restoreAllMocks(); notificationService.clearRecentNotifications();
});

describe('parked banner through OrchestratorPermissionIsland.requestPermission', () => {
  it.each([
    ['en', 'Approval needed', 'Export spreadsheet'],
    ['zh', '需要授权', '导出表格'],
  ])('ui.language=%s names the action and localizes the paused-task instruction', async (language, title, action) => {
    state.language = language;
    const notify = vi.spyOn(notificationService, 'notifyNeedsInput');
    const repo = { insert: vi.fn(), resolve: vi.fn(() => 1) };
    const island = new OrchestratorPermissionIsland({
      getSettings: () => ({ ...DEFAULT_SETTINGS, permissions: { ...DEFAULT_SETTINGS.permissions,
        autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [],
      } }),
      isDevModeAutoApproveEnabled: () => false, getExecutionTopology: () => 'main',
      hasApprovalUi: () => false, onEvent: vi.fn(),
      injectedPendingApprovalRepo: repo as unknown as PendingApprovalRepository,
    });
    getPermissionModeManager().markUnattendedSession('parked-session');
    const pending = island.requestPermission({
      type: 'file_write', tool: 'excel_generate', details: {}, sessionId: 'parked-session',
    });
    try {
      await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
      expect(repo.insert).toHaveBeenCalledOnce();
      const payload = notify.mock.calls[0][0];
      expect(payload).toMatchObject({ sessionId: 'parked-session', title, dedupeKey: expect.any(String) });
      expect(payload.body).toContain(action);
      expect(payload.body).not.toContain('excel_generate');
      if (language === 'en') {
        expect(payload.title + payload.body).not.toMatch(/[\u3400-\u9fff]/);
        expect(payload.body).toContain('The task is paused. Open Agent Neo');
      } else expect(payload.body).toContain(PARKED_APPROVAL_ENTRY_PATH);
    } finally {
      island.drainPendingPermissions();
      await pending;
    }
  });
});
