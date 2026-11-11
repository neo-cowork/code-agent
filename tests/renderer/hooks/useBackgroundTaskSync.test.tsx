// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RENDERER_POLLING } from '../../../src/shared/constants';
import type { TaskNotification } from '../../../src/shared/contract/backgroundTask';

const backgroundTaskStore = vi.hoisted(() => ({
  refreshTasks: vi.fn(async () => {}),
  drainNotifications: vi.fn<() => Promise<TaskNotification[]>>(async () => []),
  readRetryNonce: 0,
  readFailure: null as { message: string; failedAt: number } | null,
}));
const sessionStore = vi.hoisted(() => ({ currentSessionId: 'session-current' as string | null }));
const appState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
const messageActions = vi.hoisted(() => ({ sendPrompt: vi.fn(async (_content: string) => {}) }));
const ipc = vi.hoisted(() => ({
  handler: null as null | ((event: { type: string; data: unknown }) => void),
  unsubscribe: vi.fn(),
}));
const transport = vi.hoisted(() => ({ native: true }));
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
const poller = vi.hoisted(() => {
  const start = vi.fn();
  const stop = vi.fn();
  const tasks: Array<() => Promise<void>> = [];
  return {
    start,
    stop,
    tasks,
    create: vi.fn((task: () => Promise<void>) => {
      tasks.push(task);
      return { start, stop };
    }),
  };
});

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: Object.assign(
    (selector: (state: typeof backgroundTaskStore) => unknown) => selector(backgroundTaskStore),
    { getState: () => backgroundTaskStore },
  ),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof sessionStore) => unknown) => selector(sessionStore),
    { getState: () => sessionStore },
  ),
}));
vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: { getState: () => messageActions },
}));
vi.mock('../../../src/renderer/stores/appStore', () => {
  return {
    useAppStore: () => ({
      language: appState.language,
      setLanguage: vi.fn(),
      cloudUIStrings: undefined,
    }),
  };
});
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (_channel: string, handler: typeof ipc.handler) => {
      ipc.handler = handler;
      return ipc.unsubscribe;
    },
  },
}));
vi.mock('../../../src/renderer/api/transport', () => ({
  hasNativeBridge: () => transport.native,
}));
vi.mock('../../../src/renderer/utils/backoffPoller', () => ({
  createBackoffPoller: poller.create,
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast,
}));

import { useBackgroundTaskSync } from '../../../src/renderer/hooks/useBackgroundTaskSync';

describe('useBackgroundTaskSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    ipc.handler = null;
    transport.native = true;
    sessionStore.currentSessionId = 'session-current';
    appState.language = 'zh';
    backgroundTaskStore.readRetryNonce = 0;
    backgroundTaskStore.readFailure = null;
    backgroundTaskStore.refreshTasks.mockResolvedValue(undefined);
    backgroundTaskStore.drainNotifications.mockResolvedValue([]);
    poller.tasks.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces ledger invalidations and runs the existing sync path', async () => {
    renderHook(() => useBackgroundTaskSync({ pollInterval: 0 }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(backgroundTaskStore.refreshTasks).toHaveBeenCalledTimes(1);
    backgroundTaskStore.refreshTasks.mockClear();
    backgroundTaskStore.drainNotifications.mockClear();

    act(() => {
      ipc.handler?.({ type: 'background_task_ledger_changed', data: { taskId: 'task-1' } });
      ipc.handler?.({ type: 'background_task_ledger_changed', data: { taskId: 'task-1' } });
    });

    expect(backgroundTaskStore.refreshTasks).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDERER_POLLING.BACKGROUND_TASK_INVALIDATION_DEBOUNCE);
    });

    expect(backgroundTaskStore.refreshTasks).toHaveBeenCalledTimes(1);
    expect(backgroundTaskStore.drainNotifications).toHaveBeenCalledTimes(1);
    expect(backgroundTaskStore.drainNotifications).toHaveBeenCalledWith('session-current');
  });

  it('ignores unrelated events and cleans up the subscription', async () => {
    const { unmount } = renderHook(() => useBackgroundTaskSync({ pollInterval: 0 }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(backgroundTaskStore.refreshTasks).toHaveBeenCalledTimes(1);
    backgroundTaskStore.refreshTasks.mockClear();

    act(() => {
      ipc.handler?.({ type: 'task_progress', data: {} });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDERER_POLLING.BACKGROUND_TASK_INVALIDATION_DEBOUNCE);
    });

    expect(backgroundTaskStore.refreshTasks).not.toHaveBeenCalled();
    unmount();
    expect(ipc.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('formats completion toast copy through zh/en i18n', async () => {
    backgroundTaskStore.drainNotifications.mockResolvedValueOnce([{
      id: 'notice-1',
      taskId: 'task-1',
      sessionId: 'session-current',
      type: 'task_completed',
      message: '报告生成完成',
      createdAt: 1,
    }]);
    renderHook(() => useBackgroundTaskSync({ pollInterval: 0 }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toast.success).toHaveBeenCalledWith('报告生成完成。可在任务面板查看日志。');
  });

  it('renders task_cancelled as info toast and task_failed as error toast', async () => {
    backgroundTaskStore.drainNotifications.mockResolvedValueOnce([
      {
        id: 'notice-cancelled',
        taskId: 'task-1',
        sessionId: 'session-current',
        type: 'task_cancelled',
        title: '任务已停止',
        message: 'sleep 600 && echo done 已停止，耗时 不到 1 秒',
        createdAt: 1,
      },
      {
        id: 'notice-failed',
        taskId: 'task-2',
        sessionId: 'session-current',
        type: 'task_failed',
        title: '后台任务失败',
        message: 'npm test 失败，退出码 1',
        createdAt: 2,
      },
    ]);
    renderHook(() => useBackgroundTaskSync({ pollInterval: 0 }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toast.info).toHaveBeenCalledWith('sleep 600 && echo done 已停止，耗时 不到 1 秒。可在任务面板查看日志。');
    expect(toast.error).toHaveBeenCalledWith('npm test 失败，退出码 1。可在任务面板查看日志。');
  });

  const timeoutNotice = (): TaskNotification => ({
    id: 'notice-timeout',
    taskId: 'shell:task-9',
    sessionId: 'session-current',
    type: 'task_failed',
    title: '后台任务失败',
    message: 'sh /Users/me/bin/backup.sh --all 失败，耗时 30 分钟，日志 /Users/me/.code-agent/tasks/abc.log',
    createdAt: 3,
    payload: {
      taskId: 'shell:task-9',
      status: 'failed',
      outputFile: '/Users/me/.code-agent/tasks/abc.log',
      reason: 'timeout',
      maxRuntimeMs: 30 * 60 * 1000,
    },
  });

  async function renderWithNotification(notification: TaskNotification) {
    backgroundTaskStore.drainNotifications.mockResolvedValueOnce([notification]);
    renderHook(() => useBackgroundTaskSync({ pollInterval: 0 }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it.each([
    { lang: 'zh' as const, notice: '后台任务运行超过 30 分钟，已被停止。', label: '重新运行' },
    { lang: 'en' as const, notice: 'Background task ran over 30 minutes and was stopped.', label: 'Re-run' },
  ])('timeout task_failed ($lang): error toast with a re-run action that sends one plain message', async ({ lang, notice, label }) => {
    appState.language = lang;
    await renderWithNotification(timeoutNotice());

    expect(toast.error).toHaveBeenCalledTimes(1);
    const [text, action] = toast.error.mock.calls[0] as unknown as [string, { label: string; onClick: () => void }];
    expect(text).toBe(notice);
    expect(action.label).toBe(label);
    expect(text).not.toMatch(/backup\.sh|\/Users|\.log/);

    action.onClick();
    expect(messageActions.sendPrompt).toHaveBeenCalledTimes(1);
    const sent = messageActions.sendPrompt.mock.calls[0][0];
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toMatch(/backup\.sh|\/Users|\.log|sh /);
  });

  it('re-run does not send into another session after the user switched away', async () => {
    await renderWithNotification(timeoutNotice());
    const [, action] = toast.error.mock.calls[0] as unknown as [string, { onClick: () => void }];
    sessionStore.currentSessionId = 'session-other';
    action.onClick();
    expect(messageActions.sendPrompt).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it('a plain task_failed without reason renders as before (no action)', async () => {
    await renderWithNotification({ ...timeoutNotice(), payload: { status: 'failed' }, message: 'npm test 失败，退出码 1' });
    expect(toast.error).toHaveBeenCalledWith('npm test 失败，退出码 1。可在任务面板查看日志。');
    expect(messageActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('uses a 30 second fallback only when the native push bridge is available', () => {
    const nativeView = renderHook(() => useBackgroundTaskSync());
    expect(poller.create).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ baseInterval: RENDERER_POLLING.BACKGROUND_TASK_FALLBACK }),
    );
    nativeView.unmount();

    transport.native = false;
    const httpView = renderHook(() => useBackgroundTaskSync());
    expect(poller.create).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ baseInterval: RENDERER_POLLING.BACKGROUND_TASK_BASE }),
    );
    httpView.unmount();
  });

  it('stops automatic polling after the first task-ledger read failure with tasks at stake', async () => {
    backgroundTaskStore.refreshTasks.mockRejectedValueOnce(new Error('ledger unavailable'));
    // store 已置位 readFailure（确有任务、状态无法确认）→ 停轮询等用户显式重试
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };
    renderHook(() => useBackgroundTaskSync());

    const sync = poller.tasks.at(-1);
    if (!sync) throw new Error('Expected background task sync callback');
    await expect(sync()).rejects.toThrow('ledger unavailable');

    expect(poller.stop).toHaveBeenCalledTimes(1);
    backgroundTaskStore.refreshTasks.mockClear();

    await expect(sync()).resolves.toBeUndefined();
    expect(backgroundTaskStore.refreshTasks).not.toHaveBeenCalled();
  });

  it('keeps polling when an empty-ledger read fails (0 rows ≠ failure)', async () => {
    backgroundTaskStore.refreshTasks.mockRejectedValueOnce(new Error('ledger unavailable'));
    // store 未置位 readFailure（手头无任务）→ 不停轮询，靠 backoff 自动追平
    backgroundTaskStore.readFailure = null;
    renderHook(() => useBackgroundTaskSync());

    const sync = poller.tasks.at(-1);
    if (!sync) throw new Error('Expected background task sync callback');
    await expect(sync()).rejects.toThrow('ledger unavailable');

    expect(poller.stop).not.toHaveBeenCalled();
  });
});
