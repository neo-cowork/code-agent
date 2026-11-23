// 新专家首次醒来的停车通知：不指向「自动化 → 运行记录」，而是回到创建专家的对话。
// 真实 notificationService + 真实 OrchestratorPermissionIsland（parkApproval 真路径）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings } from '../../../src/shared/contract';
import { setDaemonQuitIntent } from '../../../src/host/services/daemon/quitIntent';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';

const platformMocks = vi.hoisted(() => ({
  focusedWindow: null as object | null,
  broadcast: vi.fn(),
}));

const sessionManagerStub = vi.hoisted(() => ({
  addMessageToSession: vi.fn(),
  updateMessage: vi.fn(),
}));

vi.mock('../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => platformMocks.focusedWindow },
  broadcastToRenderer: platformMocks.broadcast,
}));
vi.mock('../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
// notifyTaskResuming 的文案语言读 configService（ui.language）；本文件不测该路径，钉死 zh。
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));
// persistTaskManagerEvent / backgroundTaskTerminal 从 services barrel 拿
// { getSessionManager, notificationService }——sessionManager 打桩，notificationService 用真件。
vi.mock('../../../src/host/services', async () => {
  const real = await import('../../../src/host/services/infra/notificationService');
  return {
    getSessionManager: () => sessionManagerStub,
    notificationService: real.notificationService,
  };
});

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { persistTaskManagerEvent } from '../../../src/host/task/taskManagerEventPersistence';
import { MessageDeltaAccumulator } from '../../../src/host/protocol/messageDeltaAccumulator';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { notificationService } from '../../../src/host/services/infra/notificationService';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

function makeRepo(): PendingApprovalRepository {
  return {
    insert: vi.fn(),
    resolve: vi.fn(() => 1),
  } as unknown as PendingApprovalRepository;
}

function makeDeps() {
  return {
    turnStateBySession: new Map(),
    backgroundPermissionOwners: new Map(),
    backgroundRunTerminalErrors: new Map(),
    messageDeltaAccumulator: new MessageDeltaAccumulator(),
  };
}

describe('首次醒来会话的停车通知', () => {
  beforeEach(() => {
    resetPermissionModeManager();
    vi.useFakeTimers();
    platformMocks.focusedWindow = {};
    platformMocks.broadcast.mockClear();
    notificationService.clearRecentNotifications();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetPermissionModeManager();
    notificationService.clearRecentNotifications();
  });

  async function park(sessionId: string, firstWake: boolean) {
    setDaemonQuitIntent('background');
    const notify = vi.spyOn(notificationService, 'notifyNeedsInput');
    const modes = getPermissionModeManager();
    modes.markUnattendedSession(sessionId);
    if (firstWake) modes.markFirstWakeSession(sessionId);
    const deps = makeDeps();
    const persistence: Array<Promise<void>> = [];
    const onEvents: AgentEvent[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent: (event) => {
        onEvents.push(event);
        persistence.push(persistTaskManagerEvent(deps, sessionId, event));
      },
      injectedPendingApprovalRepo: makeRepo(),
    });
    const result = island.requestPermission({ type: 'file_write', tool: 'write_file', details: { path: '/tmp/x.txt' }, sessionId });
    for (let i = 0; i < 200 && onEvents.length === 0; i += 1) await Promise.resolve();
    await Promise.all(persistence);
    const requestId = String((onEvents[0] as { data?: { id?: string } }).data?.id);
    return { notify, island, result, requestId };
  }

  it('first-wake session → notifyNeedsInput 带「回到创建专家的对话」，且不含运行记录入口', async () => {
    const { notify, island, result, requestId } = await park('fw-notice-session', true);
    const arg = notify.mock.calls[0][0];
    expect(arg).toMatchObject({
      sessionId: 'fw-notice-session',
      title: '需要授权',
      body: '需要授权：写入文件。任务已暂停，回到刚创建专家的对话里点「允许」。',
    });
    expect(arg.body).not.toContain('运行记录');
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    notify.mockRestore();
    island.handlePermissionResponse(requestId, 'deny');
    await result;
  });

  it('普通 cron 会话仍指向运行记录（不误伤）', async () => {
    const { notify, island, result, requestId } = await park('plain-cron-session', false);
    expect(notify.mock.calls[0][0].body).toContain('运行记录');
    notify.mockRestore();
    island.handlePermissionResponse(requestId, 'deny');
    await result;
  });
});
