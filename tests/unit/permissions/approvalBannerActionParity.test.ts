// ============================================================================
// 审批横幅「动作名」五路同源（N-FIX-UX-INTERNAL-TEXT-LEAK-SYSTEMIC-WIRE-REDESIGN-FU1-APPROVAL-BODY-FU1）
//
// 前台真机横幅 owner 已在打包应用上验过（EN/ZH 标题正文），这里不重验；本文件用
// 无头测试穿过生产入口证明其余出口与前台共用同一张动作名表：
//   toolUserLabel.permissionNotice ← buildApprovalNotification（唯一拼装口）
//   (a) 前台 AgentRunController.emitAgentEvent(permission_request)
//   (b) 落库口 persistTaskManagerEvent
//   (c) 无人值守停车口 OrchestratorPermissionIsland.requestPermission（ownChat=false）
//   (d) 自己聊天断线停车口（isDetachedRun=true → ownChat=true）
//   (e) 原生兜底 NeedsInputNativeFallback.flush（shell 声明后台继续，fold 窗口后投递）
// 不变量：标题相同；动作短语来自同一张表；任何出口都不出现工具 id / 不串语言。
// 按设计（tests/unit/shared/toolUserLabel.test.ts 逐字节锁死）：停车正文 = 前台正文 +
// 停车指引后缀（不是逐字节相同——工单里「byte-identical」的说法是错的，别改文案）；
// 自己聊天断线 = 与前台逐字节相同；原生兜底是自己的句式但动作短语同源。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AgentEvent } from '../../../src/shared/contract';
import { NEEDS_INPUT_NATIVE_FALLBACK } from '../../../src/shared/constants/timeouts';
import { PARKED_APPROVAL_ENTRY_PATH } from '../../../src/shared/parkedApprovalLocation';

const state = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  quitIntent: 'none' as 'none' | 'background' | 'stop',
  broadcast: vi.fn(),
}));

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
// 原生兜底的入队门/投递门都读 quitIntent；mock 掉真模块，既可切换 background，
// 也不会触发真 setDaemonQuitIntent 的 armBackgroundContinueDetach 进程级副作用。
vi.mock('../../../src/host/services/daemon/quitIntent', () => ({
  getDaemonQuitIntent: () => state.quitIntent,
  setDaemonQuitIntent: vi.fn(),
}));
// 落库口经动态 import('../services') 拿服务；barrel 只被这条路径用到（图内其余模块
// 都是直达路径导入），回真 notificationService 单例让下面的 spy 对得上同一实例。
vi.mock('../../../src/host/services', async () => ({
  getSessionManager: () => ({}),
  notificationService: (await import('../../../src/host/services/infra/notificationService')).notificationService,
}));

import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { AgentRunController } from '../../../src/web/routes/agentRunController';
import { persistTaskManagerEvent } from '../../../src/host/task/taskManagerEventPersistence';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { DEFAULT_SETTINGS } from '../../../src/host/services/core/configDefaults';
import { MessageDeltaAccumulator } from '../../../src/host/protocol/messageDeltaAccumulator';
import { notificationService } from '../../../src/host/services/infra/notificationService';

type NeedsInputCall = { sessionId: string; title: string; body: string; tool?: string; dedupeKey?: string };

const PARKED_SUFFIX = {
  en: '. The task is paused. Open Agent Neo to review the unattended task.',
  zh: `。任务已暂停，到${PARKED_APPROVAL_ENTRY_PATH}处理。`,
} as const;

const CASES = [
  {
    language: 'en', tool: 'excel_generate', title: 'Approval needed', action: 'Export spreadsheet',
    body: 'Needs your approval: Export spreadsheet',
    parkedBody: `Needs your approval: Export spreadsheet${PARKED_SUFFIX.en}`,
    nativeBody: 'Needs your approval: Export spreadsheet', nativeTitle: 'Quarterly close',
  },
  {
    language: 'zh', tool: 'excel_generate', title: '需要授权', action: '导出表格',
    body: '等你确认：导出表格',
    parkedBody: `等你确认：导出表格${PARKED_SUFFIX.zh}`,
    nativeBody: '等你确认：导出表格', nativeTitle: '季度结算',
  },
  {
    language: 'en', tool: 'DocEdit', title: 'Approval needed', action: 'Edit document',
    body: 'Needs your approval: Edit document',
    parkedBody: `Needs your approval: Edit document${PARKED_SUFFIX.en}`,
    nativeBody: 'Needs your approval: Edit document', nativeTitle: 'Quarterly close',
  },
  {
    language: 'zh', tool: 'DocEdit', title: '需要授权', action: '编辑文档',
    body: '等你确认：编辑文档',
    parkedBody: `等你确认：编辑文档${PARKED_SUFFIX.zh}`,
    nativeBody: '等你确认：编辑文档', nativeTitle: '季度结算',
  },
] as const;

function createSink(): Response {
  return {
    writableEnded: false,
    destroyed: false,
    write: () => true,
    end: () => undefined,
    once: () => undefined,
    off: () => undefined,
  } as unknown as Response;
}

// 控制器对 permission_request.data 做防御性宽读（顶层 id/tool/resolved），payload 按
// 生产事件的松形状构造并保留 data 的必需成员（details/timestamp），`as AgentEvent`
// 两个方向才可比（tsc-tests 棘轮 TS2352，同 agentRunControllerNeedsInputNotify.test.ts）。
type PermissionRequestOverrides = { id?: string; tool?: string };

function permissionRequest(overrides: PermissionRequestOverrides = {}): AgentEvent {
  return {
    type: 'permission_request',
    data: {
      id: 'perm-req-fg',
      type: 'file_write',
      tool: 'excel_generate',
      timestamp: 1,
      details: {},
      ...overrides,
    },
  } as AgentEvent;
}

function createIsland(repo: object, detached: boolean): OrchestratorPermissionIsland {
  return new OrchestratorPermissionIsland({
    getSettings: () => ({
      ...DEFAULT_SETTINGS,
      permissions: {
        ...DEFAULT_SETTINGS.permissions,
        autoApprove: { read: false, write: false, execute: false, network: false },
        blockedCommands: [],
      },
    }),
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'main',
    hasApprovalUi: () => false,
    onEvent: vi.fn(),
    isDetachedRun: () => detached,
    injectedPendingApprovalRepo: repo as unknown as PendingApprovalRepository,
  });
}

beforeEach(() => {
  resetPermissionModeManager();
  state.broadcast.mockClear();
  notificationService.clearRecentNotifications();
});
afterEach(() => {
  resetPermissionModeManager();
  vi.restoreAllMocks();
  state.quitIntent = 'none';
  notificationService.setNativeNotificationSender(null);
  notificationService.setNotificationSessionTitleResolver(null);
  notificationService.clearRecentNotifications();
});

describe('approval banner action-name parity across the five delivery paths', () => {
  it.each(CASES)('$language/$tool: (a)前台 =(b)落库 =(d)自己聊天停车；(c)停车=前台+后缀；标题全同', async (c) => {
    state.language = c.language;
    const notify = vi.spyOn(notificationService, 'notifyNeedsInput');
    const delivered = (): NeedsInputCall[] => notify.mock.calls.map((call) => call[0] as NeedsInputCall);
    const forSession = (sessionId: string): NeedsInputCall => {
      const found = delivered().find((payload) => payload.sessionId === sessionId);
      expect(found, `no notifyNeedsInput payload for ${sessionId}`).toBeDefined();
      return found as NeedsInputCall;
    };

    // (a) 前台：真 AgentRunController，事件经 emitAgentEvent 进 maybeNotifyNeedsInput。
    const fgLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    new AgentRunController({
      res: createSink(),
      runId: 'run-parity',
      sessionId: 'fg-parity',
      logger: fgLogger,
      tryGetSessionManager: async () => null,
    }).emitAgentEvent(permissionRequest({ tool: c.tool }));
    const foreground = forSession('fg-parity');
    // 路径证明：控制器的 Needs-input notification sent 日志携带同一份 notice。
    const sentLogIndex = fgLogger.info.mock.calls.map(([message]) => message).indexOf('Needs-input notification sent');
    expect(sentLogIndex, 'controller must log "Needs-input notification sent"').toBeGreaterThanOrEqual(0);
    expect(fgLogger.info.mock.calls[sentLogIndex][1]).toEqual({ title: c.title, body: c.body });

    // (b) 落库口：公开入口 persistTaskManagerEvent。
    await persistTaskManagerEvent({
      turnStateBySession: new Map(),
      backgroundPermissionOwners: new Map(),
      backgroundRunTerminalErrors: new Map(),
      messageDeltaAccumulator: new MessageDeltaAccumulator(),
    }, 'persist-parity', {
      type: 'permission_request',
      data: { id: 'perm-req-persist', type: 'file_write', tool: c.tool, details: {}, timestamp: 1 },
    });
    const persisted = forSession('persist-parity');

    // (c) 无人值守停车：isDetachedRun=false，会话被标 unattended → context 'parked'。
    const parkedRepo = { insert: vi.fn(), resolve: vi.fn(() => 1) };
    const parkedIsland = createIsland(parkedRepo, false);
    getPermissionModeManager().markUnattendedSession('parked-parity');
    const parkedPending = parkedIsland.requestPermission({
      type: 'file_write', tool: c.tool, details: {}, sessionId: 'parked-parity',
    });
    // (d) 自己聊天断线：isDetachedRun=true 且非 unattended/语音 → context 'approval'。
    const ownRepo = { insert: vi.fn(), resolve: vi.fn(() => 1) };
    const ownIsland = createIsland(ownRepo, true);
    const ownPending = ownIsland.requestPermission({
      type: 'file_write', tool: c.tool, details: {}, sessionId: 'own-chat-parity',
    });
    try {
      await vi.waitFor(() => expect(delivered().filter((payload) => payload.sessionId === 'parked-parity')).toHaveLength(1));
      await vi.waitFor(() => expect(delivered().filter((payload) => payload.sessionId === 'own-chat-parity')).toHaveLength(1));
      const parked = forSession('parked-parity');
      const ownChat = forSession('own-chat-parity');
      expect(parkedRepo.insert).toHaveBeenCalledOnce();
      expect(ownRepo.insert).toHaveBeenCalledOnce();

      // 标题四路全同；正文 (a)=(b)=(d) 逐字节，(c)=(a)+停车后缀。
      for (const payload of [foreground, persisted, parked, ownChat]) {
        expect(payload.title).toBe(c.title);
      }
      expect(foreground.body).toBe(c.body);
      expect(persisted.body).toBe(c.body);
      expect(ownChat.body).toBe(c.body);
      expect(parked.body).toBe(c.parkedBody);
      expect(parked.body.startsWith(foreground.body)).toBe(true);
      expect(parked.body.length - foreground.body.length).toBe(PARKED_SUFFIX[c.language].length);
      // 自己聊天断线不指去运行记录（#3585）。
      expect(ownChat.body).not.toContain(PARKED_APPROVAL_ENTRY_PATH);

      // 动作短语同源：四路正文都含同一个动作名。
      for (const payload of [foreground, persisted, parked, ownChat]) {
        expect(payload.body).toContain(c.action);
      }

      // 无工具 id（原样/小写/去分隔符三种形态都不许出现）、不串语言。
      const idForms = [c.tool, c.tool.toLowerCase(), c.tool.replace(/[-_\s]/g, '')];
      for (const payload of [foreground, persisted, parked, ownChat]) {
        for (const form of idForms) expect(`${payload.title}${payload.body}`).not.toContain(form);
      }
      for (const payload of [foreground, persisted, parked, ownChat]) {
        const text = `${payload.title}${payload.body}`;
        if (c.language === 'en') expect(text).not.toMatch(/[\u3400-\u9fff]/);
        else expect(text).not.toMatch(/[A-Za-z]/); // zh 全套文案无拉丁字母，动作名也不会串成英文
      }
      // 证据口：四路捕获 + 控制器日志 notice 原样打进测试输出（验收 ①–④ 引用这一段）。
      console.log(`[parity-evidence] ${c.language}/${c.tool}`, JSON.stringify({
        foreground: { payload: foreground, loggerNotice: fgLogger.info.mock.calls[sentLogIndex][1] },
        persisted, parked, ownChat,
      }));
    } finally {
      parkedIsland.drainPendingPermissions();
      ownIsland.drainPendingPermissions();
      await parkedPending;
      await ownPending;
    }
  });

  it.each(CASES)('$language/$tool: (e)原生兜底 fold 后投递同一动作短语，无工具 id、不串语言', async (c) => {
    vi.useFakeTimers();
    try {
      state.language = c.language;
      state.quitIntent = 'background';
      const deliver = vi.fn();
      notificationService.setNativeNotificationSender(deliver);
      notificationService.setNotificationSessionTitleResolver(async () => c.nativeTitle);
      notificationService.notifyNeedsInput({
        sessionId: 'native-parity', title: c.title, body: c.body, tool: c.tool, dedupeKey: 'native-parity-key',
      });
      expect(deliver).not.toHaveBeenCalled(); // fold 窗口内不投
      await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS + 1);
      expect(deliver).toHaveBeenCalledOnce();
      const payload = deliver.mock.calls[0][0] as { id: string; sessionId: string; title: string; body: string };
      expect(payload).toMatchObject({ sessionId: 'native-parity', title: c.nativeTitle });
      expect(payload.body).toBe(c.nativeBody);
      expect(payload.body).toContain(c.action); // 与前台同一个动作短语（toolUserLabel 同表）
      const idForms = [c.tool, c.tool.toLowerCase(), c.tool.replace(/[-_\s]/g, '')];
      for (const form of idForms) expect(`${payload.title}${payload.body}`).not.toContain(form);
      if (c.language === 'en') expect(`${payload.title}${payload.body}`).not.toMatch(/[\u3400-\u9fff]/);
      else expect(payload.body).not.toMatch(/[A-Za-z]/);
      // 证据口：原生兜底 deliver 载荷原样打进测试输出（验收 ⑤ 引用这一段）。
      console.log(`[native-evidence] ${c.language}/${c.tool}`, JSON.stringify(payload));
    } finally {
      notificationService.clearRecentNotifications();
      vi.useRealTimers();
    }
  });
});
