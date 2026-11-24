// N-RUNINPUT-TOBACKGROUND-OPTION：run 终点（task_complete）对后台会话的收口。
// BackgroundTaskManager.markCompleted 此前无产线调用方（只有 dev 路由）：后台面板条目
// 永远停在 running、完成通知被焦点门吞掉。这里钉死 TaskManager 的最小接线。
// 2026-10-11 rework：只认 task_complete 不够——失败/取消/中断/max-step 撞顶轮没有
// 收尾文本，条目 spinner 永挂（无槽验收实测 12/22 分钟）。补 agent 终态事件收线
// （error 记账 → agent_complete/agent_cancelled 收口），见 backgroundTaskTerminal.ts。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_TASK_CANCELLED, ROLE_PROACTIVITY, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../src/shared/constants';
import { handleImagePayloadExceededError } from '../../../src/host/agent/runtime/contextAssembly/inferenceImagePayloadError';

const sessionManagerState = vi.hoisted(() => ({
  addMessageToSession: vi.fn(),
  updateMessage: vi.fn(),
  getSession: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  db: {
    isReady: true,
    updateSession: vi.fn(),
  },
}));

const backgroundManagerState = vi.hoisted(() => ({
  isInBackground: vi.fn(),
  isTaskRunning: vi.fn(),
  getDeferredRun: () => undefined,
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
}));

const notifyState = vi.hoisted(() => ({
  notifyTaskComplete: vi.fn(),
  notifyNeedsInput: vi.fn(),
}));
const terminalInfo = vi.hoisted(() => vi.fn());

const orchestratorMocks = vi.hoisted(() => ({
  configs: [] as Array<{ onEvent: (event: unknown) => Promise<void> }>,
  sendMessage: vi.fn(),
  setSessionId: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: (name: string) => ({
    info: name === 'BackgroundTaskTerminal' ? terminalInfo : vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: { agent: vi.fn() },
}));

vi.mock('../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    constructor(config: { onEvent: (event: unknown) => Promise<void> }) {
      orchestratorMocks.configs.push(config);
    }
    sendMessage = (...args: unknown[]) => orchestratorMocks.sendMessage(...args);
    setSessionId = (...args: unknown[]) => orchestratorMocks.setSessionId(...args);
  },
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
  notificationService: notifyState,
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => dbState.db,
}));

vi.mock('../../../src/host/session/backgroundTaskManager', () => ({
  getBackgroundTaskManager: () => backgroundManagerState,
}));

import { TaskManager } from '../../../src/host/task/TaskManager';
import { withWakeRunTimeout } from '../../../src/host/services/roleAssets/wakeRunGuard';
import { notificationService } from '../../../src/host/services/infra/notificationService';

const TASK_COMPLETE_EVENT = {
  type: 'task_complete',
  data: { turnId: 'turn-1', summary: '周报已写好', duration: 4200, toolsUsed: ['Write'] },
} as const;

function newManager(): TaskManager {
  const manager = new TaskManager({ maxConcurrentTasks: 1 });
  manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
  return manager;
}

describe('task_complete 的后台收口（完成通知/面板状态）', () => {
  beforeEach(() => {
    sessionManagerState.getSession.mockReset().mockResolvedValue({
      id: 'session-1',
      title: '长任务',
    });
    backgroundManagerState.isInBackground.mockReset().mockReturnValue(false);
    backgroundManagerState.isTaskRunning.mockReset().mockReturnValue(true);
    backgroundManagerState.markCompleted.mockReset().mockResolvedValue(undefined);
    backgroundManagerState.markFailed.mockReset();
    notifyState.notifyTaskComplete.mockClear();
    terminalInfo.mockClear();
    dbState.db.updateSession.mockReset();
    orchestratorMocks.configs.length = 0;
  });

  it('后台会话的主 run 完成：交给 markCompleted 收口，不再走普通通知（避免双响）', async () => {
    backgroundManagerState.isInBackground.mockReturnValue(true);
    const manager = newManager();

    await (manager as unknown as {
      persistEventToSession: (sessionId: string, event: unknown, snapshot?: unknown, eventKey?: string) => Promise<void>;
    }).persistEventToSession('session-1', TASK_COMPLETE_EVENT, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).toHaveBeenCalledWith('session-1', '周报已写好', 4200);
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();
  });

  it('前台会话完成：保持原行为（普通完成通知），不碰后台管理器', async () => {
    const manager = newManager();

    await (manager as unknown as {
      persistEventToSession: (sessionId: string, event: unknown, snapshot?: unknown, eventKey?: string) => Promise<void>;
    }).persistEventToSession('session-1', TASK_COMPLETE_EVENT, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).not.toHaveBeenCalled();
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      sessionTitle: '长任务',
      summary: '周报已写好',
    }));
  });

  const wakeSession = (trigger: string) => ({
    id: 'session-1', title: '研究员 · 主动巡检', type: 'schedule',
    origin: { kind: 'cron', name: ROLE_PROACTIVITY.CADENCE_JOB_TAG, metadata: { roleId: '研究员', trigger } },
  });
  const persistTaskComplete = () => (newManager() as unknown as {
    persistEventToSession: (sessionId: string, event: unknown, snapshot?: unknown, eventKey?: string) => Promise<void>;
  }).persistEventToSession('session-1', TASK_COMPLETE_EVENT, undefined, 'session-1');

  it.each(['cadence', 'event', 'first_wake'])('role wake %s task_complete leaves the summary notification budget untouched', async (trigger) => {
    sessionManagerState.getSession.mockResolvedValue(wakeSession(trigger));
    await withWakeRunTimeout(persistTaskComplete, {
      roleId: '研究员', sessionId: 'session-1', phase: 'wake-run', timeoutMs: 60_000, cancel: () => undefined,
    });
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();
    expect(backgroundManagerState.markCompleted).not.toHaveBeenCalled();
  });

  it('a follow-up run on the kept wake session keeps its generic completion notice', async () => {
    sessionManagerState.getSession.mockResolvedValue(wakeSession('cadence'));
    await persistTaskComplete();
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
  });

  it('whenAgentEventsSettled waits for in-flight (un-awaited) event handling of that session only', async () => {
    const manager = newManager() as unknown as {
      trackEventHandling: (sessionId: string, handling: Promise<void>) => Promise<void>;
      whenAgentEventsSettled: (sessionId: string) => Promise<void>;
    };
    let finish!: () => void;
    manager.trackEventHandling('session-1', new Promise<void>((resolve) => { finish = resolve; }));
    let settled = false;
    const waiting = manager.whenAgentEventsSettled('session-1').then(() => { settled = true; });
    await manager.whenAgentEventsSettled('other-session');
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await waiting;
    expect(settled).toBe(true);
  });

  it('ordinary scheduled session task_complete keeps its generic completion notice', async () => {
    sessionManagerState.getSession.mockResolvedValue({
      id: 'session-1', title: '每周简报', type: 'schedule',
      origin: { kind: 'cron', name: 'weekly-brief' },
    });
    const manager = newManager();
    await (manager as unknown as {
      persistEventToSession: (sessionId: string, event: unknown, snapshot?: unknown, eventKey?: string) => Promise<void>;
    }).persistEventToSession('session-1', TASK_COMPLETE_EVENT, undefined, 'session-1');
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', summary: '周报已写好' }));
  });

  it('skips a sub-task completion banner while the primary run is running', async () => {
    backgroundManagerState.isInBackground.mockReturnValue(true);
    const manager = newManager();
    vi.spyOn(manager, 'getSessionState').mockReturnValue({ status: 'running' });

    await (manager as unknown as {
      persistEventToSession: (sessionId: string, event: unknown, snapshot?: unknown, eventKey?: string) => Promise<void>;
    }).persistEventToSession('session-1', TASK_COMPLETE_EVENT, undefined, 'subagent-key');

    expect(backgroundManagerState.markCompleted).not.toHaveBeenCalled();
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(0);
    expect(terminalInfo).toHaveBeenCalledExactlyOnceWith(
      'sub-task completion banner skipped: primary run active',
      { sessionId: 'session-1', eventKey: 'subagent-key' },
    );
    console.info(...terminalInfo.mock.calls[0]);
  });

  it('sends one late sub-task completion banner without a duration line', async () => {
    const manager = newManager();
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
    notificationService.clearRecentNotifications();
    notifyState.notifyTaskComplete.mockImplementationOnce((data) => notificationService.notifyTaskComplete(data));
    try {
      await (manager as unknown as {
        persistEventToSession: (sessionId: string, event: unknown, snapshot?: unknown, eventKey?: string) => Promise<void>;
      }).persistEventToSession('session-1', TASK_COMPLETE_EVENT, undefined, 'subagent-key');

      expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
      expect(notifyState.notifyTaskComplete.mock.calls[0][0]).not.toHaveProperty('duration');
      const notifications = notificationService.getRecentNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].body).toBe('周报已写好');
      expect(notifications[0].body).not.toMatch(/耗时|Duration/);
      console.info('Late sub-task banner body:', JSON.stringify(notifications[0].body));
    } finally {
      notificationService.clearRecentNotifications();
      vi.unstubAllEnvs();
    }
  });

  it('sends only the primary duration after a sub-task completes during a direct web run', async () => {
    const manager = newManager();
    const activePrimaryRun = vi.spyOn(manager, 'hasActivePrimaryRun').mockReturnValue(true);
    const persist = (manager as unknown as {
      persistEventToSession: (sessionId: string, event: unknown, snapshot?: unknown, eventKey?: string) => Promise<void>;
    }).persistEventToSession.bind(manager);

    await persist('session-1', TASK_COMPLETE_EVENT, undefined, 'subagent-key');
    activePrimaryRun.mockReturnValue(false);
    await persist('session-1', {
      ...TASK_COMPLETE_EVENT,
      data: { ...TASK_COMPLETE_EVENT.data, duration: 27_000 },
    }, undefined, 'session-1');

    expect(notifyState.notifyTaskComplete).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-1',
      sessionTitle: '长任务',
      summary: '周报已写好',
      duration: 27_000,
      toolsUsed: ['Write'],
    });
  });
});

describe('agent 终态事件的后台收线（失败/取消/中断/max-step 撞顶轮）', () => {
  type Persist = (sessionId: string, event: unknown, snapshot?: unknown, eventKey?: string) => Promise<void>;

  function getPersist(manager: TaskManager): Persist {
    return (manager as unknown as { persistEventToSession: Persist }).persistEventToSession.bind(manager);
  }

  function imagePayloadRecoveryEvent(): unknown {
    const onEvent = vi.fn();
    handleImagePayloadExceededError({
      ctx: {
        runtime: {
          modelConfig: { provider: 'mock', model: 'test-model' },
          onEvent,
        },
      } as never,
      error: Object.assign(new Error('request too large'), { status: 413, provider: 'mock', model: 'test-model' }),
      llmCallId: 'llm-image-1',
      langfuse: { endGeneration: vi.fn() } as never,
    });
    return onEvent.mock.calls[0]?.[0];
  }

  beforeEach(() => {
    sessionManagerState.getSession.mockReset().mockResolvedValue({
      id: 'session-1',
      title: '长任务',
    });
    backgroundManagerState.isInBackground.mockReset().mockReturnValue(true);
    backgroundManagerState.isTaskRunning.mockReset().mockReturnValue(true);
    backgroundManagerState.markCompleted.mockReset().mockResolvedValue(undefined);
    backgroundManagerState.markFailed.mockReset();
    notifyState.notifyTaskComplete.mockClear();
    orchestratorMocks.configs.length = 0;
  });

  it('撞 max-step 上限（error 事件带稳定 code → agent_complete）：markFailed 收线，传 code 给 renderer 翻译', async () => {
    const persist = getPersist(newManager());

    await persist('session-1', {
      type: 'error',
      data: { message: 'Max iterations reached', code: RUN_ERROR_CODE_MAX_ITERATIONS },
    }, undefined, 'session-1');
    await persist('session-1', { type: 'agent_complete', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markFailed).toHaveBeenCalledWith('session-1', RUN_ERROR_CODE_MAX_ITERATIONS);
    expect(backgroundManagerState.markCompleted).not.toHaveBeenCalled();
  });

  it('失败轮（error 事件带消息 → agent_complete）：markFailed 收原始消息', async () => {
    const persist = getPersist(newManager());

    await persist('session-1', {
      type: 'error',
      data: { message: 'Provider auth failure' },
    }, undefined, 'session-1');
    await persist('session-1', { type: 'agent_complete', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markFailed).toHaveBeenCalledWith('session-1', 'Provider auth failure');
  });

  it('取消轮（agent_cancelled，无 error）：markCompleted + USER_CANCELLED 标记（不是失败）', async () => {
    const persist = getPersist(newManager());

    await persist('session-1', { type: 'agent_cancelled', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).toHaveBeenCalledWith('session-1', BACKGROUND_TASK_CANCELLED);
    expect(backgroundManagerState.markFailed).not.toHaveBeenCalled();
  });

  it('生产图片超限事件带 terminal:false，随后用户取消仍按取消收线（r2）', async () => {
    const persist = getPersist(newManager());

    await persist('session-1', imagePayloadRecoveryEvent(), undefined, 'session-1');
    await persist('session-1', { type: 'agent_cancelled', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).toHaveBeenCalledWith('session-1', BACKGROUND_TASK_CANCELLED);
    expect(backgroundManagerState.markFailed).not.toHaveBeenCalled();
  });

  it('仅 agent_complete（research/auto-agent 成功形状，无 task_complete 无 error）：按完成收线，不再误报「已停止」（r4）', async () => {
    const persist = getPersist(newManager());

    await persist('session-1', { type: 'agent_complete', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).toHaveBeenCalledWith('session-1', undefined);
    expect(backgroundManagerState.markFailed).not.toHaveBeenCalled();
  });

  it('生产图片超限事件后 agent_complete：可恢复 error 不决定终态（r4）', async () => {
    const persist = getPersist(newManager());

    await persist('session-1', imagePayloadRecoveryEvent(), undefined, 'session-1');
    await persist('session-1', { type: 'agent_complete', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).toHaveBeenCalledWith('session-1', undefined);
    expect(backgroundManagerState.markFailed).not.toHaveBeenCalled();
  });

  it('成功轮（task_complete 已收口）后再到 agent_complete：running-guard 挡住，不双收线', async () => {
    backgroundManagerState.isTaskRunning.mockReturnValue(false); // task_complete 收口后
    const persist = getPersist(newManager());

    await persist('session-1', TASK_COMPLETE_EVENT, undefined, 'session-1');
    await persist('session-1', { type: 'agent_complete', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).toHaveBeenCalledTimes(1);
    expect(backgroundManagerState.markCompleted).toHaveBeenCalledWith('session-1', '周报已写好', 4200);
    expect(backgroundManagerState.markFailed).not.toHaveBeenCalled();
  });

  it('前台轮的 agent_complete：不碰后台管理器', async () => {
    backgroundManagerState.isInBackground.mockReturnValue(false);
    const persist = getPersist(newManager());

    await persist('session-1', {
      type: 'error',
      data: { message: 'boom' },
    }, undefined, 'session-1');
    await persist('session-1', { type: 'agent_complete', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).not.toHaveBeenCalled();
    expect(backgroundManagerState.markFailed).not.toHaveBeenCalled();
  });

  it('子代理的 error（eventKey ≠ sessionId）不记账：主轮随后取消仍按取消收线，不被污染', async () => {
    const persist = getPersist(newManager());

    await persist('session-1', {
      type: 'error',
      data: { message: 'subagent blew up', code: 'SUBAGENT_ERROR' },
    }, undefined, 'subagent-key');
    await persist('session-1', { type: 'agent_cancelled', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).toHaveBeenCalledWith('session-1', BACKGROUND_TASK_CANCELLED);
    expect(backgroundManagerState.markFailed).not.toHaveBeenCalled();
  });
});
