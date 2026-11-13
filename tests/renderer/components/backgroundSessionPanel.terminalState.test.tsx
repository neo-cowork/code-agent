// @vitest-environment jsdom
// ============================================================================
// BackgroundSessionPanel 终态行契约（N-RUNINPUT-TOBACKGROUND-OPTION 2026-10-11 rework）
// ============================================================================
// 无槽验收实测：后台任务撞 max-step 上限结束后，面板 spinner 永不收线（12/22 分钟）。
// 契约：每个终态（成功/失败/撞顶停止/取消）都必须停 spinner 并给一行结果——
// completionMessage 携带稳定 code（MAX_ITERATIONS_REACHED / USER_CANCELLED）时翻译成人话，
// 其余原样展示；running 条目才有 spinner 与计时。

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundSessionPanel } from '../../../src/renderer/components/features/background/BackgroundSessionPanel';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import type { BackgroundSessionInfo } from '../../../src/shared/contract/sessionState';
import { BACKGROUND_TASK_CANCELLED, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../src/shared/constants';

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
