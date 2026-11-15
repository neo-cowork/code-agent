import { afterEach, describe, expect, it, vi } from 'vitest';

// N-FIX-FLAKY-TERMINAL-RESULT-PROJECTION-LATE-SETTLE：
// recordBackgroundTaskStopNote 会在 TaskManager 尚未 initialize() 的窗口里被迟到调用
// （登录恢复 / 定时器重试补投 [任务结果] 行的 stopped 说明，触发时宿主可能已拆除）。
// 旧代码 emitAgentEventForSession 无条件走 handleAgentEvent → this.onAgentEvent! 抛
// TypeError「this.onAgentEvent is not a function」，又因 void 无人接 → vitest 报
// Unhandled rejection，整轮退出 1（CI 11-15 PR #3427/#3428 两次假红）。
// 这里走公开入口 + 真实未初始化 TaskManager 钉住收口行为：调用必须 resolve、
// 一个 tick 内无 unhandled rejection、且恰好留一条可区分的 warn。
// 只替换 getSessionManager（写路径不需要真库）与 logger（捕获 warn）；
// platform/agentOrchestrator/databaseService 是 import 安全档，与
// tests/unit/task/TaskManager.persistence.test.ts 同款，不改被测行为。

const logCapture = vi.hoisted(() => ({
  warns: [] as Array<{ message: string; details?: Record<string, unknown> }>,
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: (message: string, details?: Record<string, unknown>) => {
      logCapture.warns.push({ message, details });
    },
  }),
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: async () => undefined,
  }),
}));

vi.mock('../../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {},
}));

vi.mock('../../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
  broadcastToRenderer: vi.fn(),
  hasInteractiveUi: () => false,
}));

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: true, updateSession: vi.fn() }),
}));

import { recordBackgroundTaskStopNote } from '../../../../src/host/services/commandCenter/backgroundTaskStopNote';
import { resetTaskManager } from '../../../../src/host/task/TaskManager';

describe('recordBackgroundTaskStopNote 在 TaskManager 未初始化窗口里的收口', () => {
  afterEach(() => {
    resetTaskManager();
    logCapture.warns.length = 0;
  });

  it('迟到调用安静 resolve，无 unhandled rejection，恰好留一条可区分 warn', async () => {
    // resetTaskManager() 清掉单例：下一次 getTaskManager() 创建「存在但未 initialize」的
    // 真实例 —— 正是 CI 上迟到补投撞到的形态（onAgentEvent 为 null）。
    resetTaskManager();
    const unhandled: Array<{ reason: unknown }> = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push({ reason });
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(recordBackgroundTaskStopNote('session-late', '周报', '已到步数上限，任务停止', {
        taskId: 'task-late-1', kind: 'step_cap',
      })).resolves.toBeUndefined();
      // unhandled rejection 在微任务清空后才触发：多等几个宏任务 tick 再断言。
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    const warns = logCapture.warns.filter((entry) => entry.details?.reason === 'emit_agent_event_before_initialize');
    expect(warns).toHaveLength(1);
    expect(warns[0].details).toMatchObject({ sessionId: 'session-late', eventType: 'message' });
  });
});
