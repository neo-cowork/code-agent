// @vitest-environment jsdom
// ============================================================================
// BackgroundSessionPanel 终态行契约（N-RUNINPUT-TOBACKGROUND-OPTION 2026-10-11 rework）
// ============================================================================
// 无槽验收实测：后台任务撞 max-step 上限结束后，面板 spinner 永不收线（12/22 分钟）。
// 契约：每个终态（成功/失败/撞顶停止/取消）都必须停 spinner 并给一行结果——
// completionMessage 携带稳定 code（MAX_ITERATIONS_REACHED / USER_CANCELLED）时翻译成人话，
// 其余原样展示；running 条目才有 spinner 与计时。

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundSessionPanel } from '../../../src/renderer/components/features/background/BackgroundSessionPanel';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import type { BackgroundSessionInfo } from '../../../src/shared/contract/sessionState';
import { BACKGROUND_TASK_CANCELLED, BACKGROUND_TASK_DELETE_INCOMPLETE, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../src/shared/constants';

function backgroundTask(overrides: Partial<BackgroundSessionInfo>): BackgroundSessionInfo {
  return {
    sessionId: 's1',
    title: '长任务',
    startedAt: Date.now(),
    backgroundedAt: Date.now(),
    status: 'running',
    ...overrides,
  };
}

function renderPanelWith(task: BackgroundSessionInfo) {
  useSessionStore.setState({ backgroundSessions: [task] });
  return render(<BackgroundSessionPanel />);
}

function itemLine(): string {
  return screen.getByTestId('background-session-item-line').textContent ?? '';
}

// 纯函数表经渲染断言（函数保持模块私有，knip production 口径不认测试消费）：
// running → 计时行；终态 → 结果行（code 翻译 / 消息直通 / 默认行）。
describe('状态行映射（经渲染）', () => {
  afterEach(() => {
    cleanup();
    useSessionStore.setState({ backgroundSessions: [] });
  });

  it('running → 计时态（秒/分钟/小时三档）', () => {
    // 假计时器：面板的 1s interval 在高负载下可能在断言间跳动（实测全目录跑时抖过一次
    // 红），冻结系统时间后计时行完全确定。
    vi.useFakeTimers();
    try {
      renderPanelWith(backgroundTask({ startedAt: Date.now() - 4_000 }));
      expect(itemLine()).toBe('4秒');
      cleanup();

      renderPanelWith(backgroundTask({ startedAt: Date.now() - 125_000 }));
      expect(itemLine()).toBe('2分钟');
      cleanup();

      renderPanelWith(backgroundTask({ startedAt: Date.now() - 7_325_000 }));
      expect(itemLine()).toBe('2小时2分钟');
    } finally {
      vi.useRealTimers();
    }
  });

  it('completed / failed 空消息 → 默认结果行', () => {
    renderPanelWith(backgroundTask({ status: 'completed' }));
    expect(itemLine()).toBe('已完成');
    cleanup();

    renderPanelWith(backgroundTask({ status: 'failed' }));
    expect(itemLine()).toBe('执行失败');
  });

  it('稳定 code 翻译成人话：撞顶停止 / 用户取消', () => {
    renderPanelWith(backgroundTask({ status: 'failed', completionMessage: RUN_ERROR_CODE_MAX_ITERATIONS }));
    expect(itemLine()).toBe('已达轮次上限，已停止（部分结果已保留）');
    cleanup();

    renderPanelWith(backgroundTask({ status: 'completed', completionMessage: BACKGROUND_TASK_CANCELLED }));
    expect(itemLine()).toBe('已取消');
  });

  it.each([
    ['zh', '任务未完成', '已完成', '删除没有成功，文件还在', '重试', '换个方式'],
    ['en', 'Task incomplete', 'Completed', 'The files are still there because the deletion did not succeed', 'Retry', 'Try another way'],
  ] as const)('shows both %s recovery actions only on the incomplete background row', (language, incomplete, completed, reason, retry, alternate) => {
    useAppStore.setState({ language });
    try {
      renderPanelWith(backgroundTask({
        title: '已完成删除 / Deleted all files',
        status: 'failed',
        completionMessage: BACKGROUND_TASK_DELETE_INCOMPLETE,
        leftoverPaths: ['/temporary/exports/export.csv'],
      }));
      expect(screen.getByRole('button', { name: retry })).toBeTruthy();
      expect(screen.getByRole('button', { name: alternate })).toBeTruthy();
      expect(screen.getByTestId('background-session-clear')).toBeTruthy();
      const row = screen.getByTestId('background-session-item');
      expect(row.textContent).toContain('export.csv');
      expect(row.textContent).not.toMatch(/已完成|Deleted all files/);
      expect(itemLine()).toContain(incomplete);
      expect(itemLine()).toContain(reason);
      expect(itemLine().replace(incomplete, '')).not.toMatch(/完成|completed|DELETE_INCOMPLETE|\/temporary/i);
      cleanup();
      renderPanelWith(backgroundTask({ status: 'completed' }));
      expect(itemLine()).toBe(completed);
      expect(screen.queryByTestId('delete-incomplete-actions')).toBeNull();
      cleanup();
      renderPanelWith(backgroundTask({ status: 'failed' }));
      expect(screen.queryByTestId('delete-incomplete-actions')).toBeNull();
      cleanup();
      renderPanelWith(backgroundTask({ completionMessage: BACKGROUND_TASK_DELETE_INCOMPLETE }));
      expect(screen.queryByTestId('delete-incomplete-actions')).toBeNull();
    } finally {
      cleanup();
      useAppStore.setState({ language: 'zh' });
    }
  });

  it('其余消息原样展示（engine 终态消息直通）', () => {
    renderPanelWith(backgroundTask({ status: 'failed', completionMessage: 'Provider auth failure' }));
    expect(itemLine()).toBe('Provider auth failure');
  });
});

describe('面板终态渲染（spinner 必须停 + 结果行必须给）', () => {
  afterEach(() => {
    cleanup();
    useSessionStore.setState({ backgroundSessions: [] });
  });

  it('running 条目：spinner 在场', () => {
    renderPanelWith(backgroundTask({ status: 'running' }));
    const item = screen.getByTestId('background-session-item');
    expect(item.getAttribute('data-status')).toBe('running');
    expect(item.querySelector('.animate-spin')).not.toBeNull();
  });

  it('撞顶停止（MAX_ITERATIONS code）：spinner 停 + 撞顶结果行', () => {
    renderPanelWith(backgroundTask({ status: 'failed', completionMessage: RUN_ERROR_CODE_MAX_ITERATIONS }));
    const item = screen.getByTestId('background-session-item');
    expect(item.getAttribute('data-status')).toBe('failed');
    expect(item.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByTestId('background-session-item-line').textContent)
      .toBe('已达轮次上限，已停止（部分结果已保留）');
  });

  it('用户取消（USER_CANCELLED code）：spinner 停 + 已取消行', () => {
    renderPanelWith(backgroundTask({ status: 'completed', completionMessage: BACKGROUND_TASK_CANCELLED }));
    expect(screen.getByTestId('background-session-item').querySelector('.animate-spin')).toBeNull();
    expect(screen.getByTestId('background-session-item-line').textContent).toBe('已取消');
  });

  it('成功：spinner 停 + 已完成行；失败空消息：执行失败行', () => {
    renderPanelWith(backgroundTask({ status: 'completed' }));
    expect(screen.getByTestId('background-session-item').querySelector('.animate-spin')).toBeNull();
    expect(screen.getByTestId('background-session-item-line').textContent).toBe('已完成');
    cleanup();

    renderPanelWith(backgroundTask({ status: 'failed' }));
    expect(screen.getByTestId('background-session-item-line').textContent).toBe('执行失败');
  });
});

describe('前台已停止时后台行的词跟终态走', () => {
  afterEach(() => {
    cleanup();
    useSessionStore.setState({ backgroundSessions: [] });
    useTaskStore.setState({ sessionStates: {} });
  });

  it('taskStore 判定 cancelled 而条目仍 running：行里是「已取消」而不是计时', () => {
    useTaskStore.setState({ sessionStates: { s1: { status: 'cancelled' } } });
    renderPanelWith(backgroundTask({ status: 'running' }));
    expect(itemLine()).toBe('已取消');
  });
});

describe('后台行的失败判定（唯一一步失败不能写「已完成」）', () => {
  const originalApi = window.domainAPI;
  afterEach(() => {
    cleanup();
    useSessionStore.setState({ backgroundSessions: [] });
    (window as { domainAPI?: unknown }).domainAPI = originalApi;
  });

  // 形状取自 getMessages 的真实返回：落库原始 Message[]，工具结果在 tool 消息的 toolResults 里（不是 toolCalls[].result）
  function mockSessionMessages(results: Array<{ success: boolean }>) {
    const invoke = vi.fn().mockResolvedValue({
      success: true,
      data: [
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          timestamp: 1,
          toolCalls: results.map((_, index) => ({ id: `c${index}`, name: 'bash', arguments: {} })),
        },
        {
          id: 'm2',
          role: 'tool',
          content: '',
          timestamp: 2,
          toolResults: results.map((result, index) => ({ toolCallId: `c${index}`, ...result })),
        },
      ],
    });
    (window as { domainAPI?: unknown }).domainAPI = { invoke };
    return invoke;
  }

  it.each([false, true])('旧轮失败 + 新轮干净完成（有成功工具=%s）→ 已完成', async (hasSuccessfulTool) => {
    const invoke = mockSessionMessages([{ success: false }]);
    const oldMessages = (await invoke()).data;
    invoke.mockClear();
    // 显式等待异步读取完成，避免初始「已完成」造成假绿。
    invoke.mockResolvedValue({
      success: true,
      data: [
        { id: 'old-user', role: 'user', content: '整理旧报告', timestamp: 0 },
        ...oldMessages,
        { id: 'new-user', role: 'user', content: '整理新报告', timestamp: 3 },
        ...(hasSuccessfulTool ? [{
          id: 'new-tool', role: 'tool', content: '', timestamp: 4,
          toolResults: [{ toolCallId: 'new-call', success: true }],
        }] : []),
        { id: 'new-answer', role: 'assistant', content: '报告已整理。', timestamp: 5 },
      ],
    });
    await act(async () => {
      renderPanelWith(backgroundTask({ status: 'completed' }));
    });
    expect(itemLine()).toBe('已完成');
    expect(itemLine()).not.toBe('已完成，有提醒');
  });

  it('completed 但唯一一步失败 → 「执行失败」，不是「已完成」', async () => {
    const invoke = mockSessionMessages([{ success: false }]);
    renderPanelWith(backgroundTask({ status: 'completed' }));
    await waitFor(() => expect(itemLine()).toBe('执行失败'));
    // 只读路由：绝不能调 session.load（会切走宿主 currentSessionId）
    expect(invoke).toHaveBeenCalledWith('domain:session', 'getMessages', { sessionId: 's1' });
    expect(invoke.mock.calls.some((call) => call[1] === 'load')).toBe(false);
  });

  it('completed 且部分步骤失败 → 「已完成，有提醒」', async () => {
    const invoke = mockSessionMessages([{ success: true }, { success: false }]);
    renderPanelWith(backgroundTask({ status: 'completed' }));
    await waitFor(() => expect(itemLine()).toBe('已完成，有提醒'));
    expect(invoke.mock.calls.some((call) => call[1] === 'load')).toBe(false);
  });

  it('completed 且步骤全成功 → 仍是「已完成」', async () => {
    const invoke = mockSessionMessages([{ success: true }]);
    renderPanelWith(backgroundTask({ status: 'completed' }));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(itemLine()).toBe('已完成');
  });
});

describe('面板行主名读实时会话标题', () => {
  afterEach(() => {
    cleanup();
    useSessionStore.setState({ backgroundSessions: [], sessions: [] });
  });

  it('会话 store 里的实时标题优先于 host 快照；不在 store 时回落快照；改名后无需重载', () => {
    useSessionStore.setState({
      sessions: [{ id: 's1', title: '服务合同要点' }] as never,
      backgroundSessions: [backgroundTask({ title: '看看 workspace' })],
    });
    render(<BackgroundSessionPanel />);
    const row = () => screen.getByTestId('background-session-foreground').textContent ?? '';
    expect(row()).toContain('服务合同要点');
    expect(row()).not.toContain('看看 workspace');

    act(() => {
      useSessionStore.setState({ sessions: [{ id: 's1', title: '合同摘要（改名）' }] as never });
    });
    expect(row()).toContain('合同摘要（改名）');

    act(() => { useSessionStore.setState({ sessions: [] }); });
    expect(row()).toContain('看看 workspace');
  });
});


describe('incomplete background row actions', () => {
  const failedDelete = () => backgroundTask({
    status: 'failed',
    completionMessage: BACKGROUND_TASK_DELETE_INCOMPLETE,
    leftoverPaths: ['/home/fixture/exports/spring.csv'],
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useSessionStore.setState({ currentSessionId: null, backgroundSessions: [], messages: [], runningSessionIds: new Set() });
  });

  it('opens the owning session and sends the selected prompt once', async () => {
    useSessionStore.setState({ currentSessionId: 'other-session' });
    const sendPrompt = vi.spyOn(useMessageActionStore.getState(), 'sendPrompt').mockResolvedValue();
    const open = vi.spyOn(useSessionStore.getState(), 'switchSession').mockImplementation(async (sessionId) => {
      useSessionStore.setState({ currentSessionId: sessionId });
    });
    renderPanelWith(failedDelete());

    fireEvent.click(screen.getByRole('button', { name: '换个方式' }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledExactlyOnceWith('s1');
    expect(sendPrompt).toHaveBeenCalledWith('上次删除受阻，这些文件还在：spring.csv。请试试别的办法。', {
      clientMessageId: expect.stringMatching(/^delete-incomplete-retry-s1-/),
    });
  });

  it('rechecks persisted retries after opening the owning session', async () => {
    const task = failedDelete();
    useSessionStore.setState({ currentSessionId: 'other-session' });
    const sendPrompt = vi.spyOn(useMessageActionStore.getState(), 'sendPrompt').mockResolvedValue();
    vi.spyOn(useSessionStore.getState(), 'switchSession').mockImplementation(async (sessionId) => {
      useSessionStore.setState({
        currentSessionId: sessionId,
        messages: [{
          id: `delete-incomplete-retry-s1-${task.startedAt}-previous`,
          role: 'user',
          content: 'previous retry',
          timestamp: task.startedAt + 100,
        }],
      });
    });
    renderPanelWith(task);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })); });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '换个方式' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables both panel actions while the owning session is active', () => {
    useSessionStore.setState({ currentSessionId: 'other-session', runningSessionIds: new Set(['s1']) });
    renderPanelWith(failedDelete());
    expect((screen.getByRole('button', { name: '重试' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '换个方式' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
