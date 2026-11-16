// @vitest-environment jsdom
// ============================================================================
// ContextHealthDetailPopover — 总量真源标注（N-CTXTRUTH 病B）
// 口径：tokenSource='provider' 时大数字行旁显示估/实偏差（本地估算相对实报）；
// 'estimated'（含老状态缺省）时显示「估算」标注，不显示偏差。
// 反向变异承重：删掉弹层的偏差/标注渲染分支，全部用例必须红。
// ============================================================================

import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextHealthState } from '../../../src/shared/contract/contextHealth';

function makeHealth(overrides: Partial<ContextHealthState>): ContextHealthState {
  return {
    currentTokens: 10000,
    maxTokens: 100000,
    usagePercent: 10,
    breakdown: {
      systemPrompt: 1000,
      messages: 9000,
      toolResults: 0,
      bySource: {
        rules: 0,
        skills: {},
        mcp: {},
        subagents: {},
        fileReads: 0,
        summary: 0,
        conversation: 9000,
      },
    },
    warningLevel: 'normal',
    estimatedTurnsRemaining: 10,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

const pillMocks = vi.hoisted(() => ({
  appState: {
    contextHealth: undefined as ContextHealthState | undefined,
    openWorkbenchTab: vi.fn(),
    setActiveWorkbenchTab: vi.fn(),
    setWorkbenchHighlight: vi.fn(),
    // useI18n() 无 selector 整取 store，这几个字段得在。
    language: 'zh' as 'zh' | 'en',
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  },
  statusState: {
    sessionCost: 0,
    unknownCostTurns: 0,
    isStreaming: false,
  },
  invoke: vi.fn(),
  invokeDomain: vi.fn(),
  refreshContextHealth: vi.fn(),
  unmountSkill: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof pillMocks.appState) => unknown) => (
    selector ? selector(pillMocks.appState) : pillMocks.appState
  ),
}));

vi.mock('../../../src/renderer/stores/statusStore', () => ({
  useStatusStore: (selector: (state: typeof pillMocks.statusState) => unknown) => selector(pillMocks.statusState),
}));

vi.mock('../../../src/renderer/hooks/useBudgetStatus', () => ({
  useBudgetStatus: () => null,
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const state = () => ({
    currentSessionId: 'session-1',
    messages: [],
    isHydratingSession: false,
    refreshContextHealth: pillMocks.refreshContextHealth,
  });
  return { useSessionStore: Object.assign(
    (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
    { getState: state },
  ) };
});

vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: (selector?: (state: { unmountSkill: typeof pillMocks.unmountSkill }) => unknown) => {
    const state = { unmountSkill: pillMocks.unmountSkill };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: pillMocks.invoke,
    invokeDomain: pillMocks.invokeDomain,
  },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { ContextUsagePill } from '../../../src/renderer/components/features/chat/ContextUsagePill';
import { useContextCompactionStore } from '../../../src/renderer/stores/contextCompactionStore';

function openPopover() {
  render(<form><ContextUsagePill /></form>);
  fireEvent.click(screen.getByRole('button', { name: /上下文使用|Context usage/ }));
}

describe('ContextHealthDetailPopover — 总量真源标注（N-CTXTRUTH）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pillMocks.appState.language = 'zh';
    useContextCompactionStore.setState({ status: 'idle', result: null, error: null, updatedAt: 0 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('provider 实报轮次：显示估/实偏差，不显示「估算」标注', () => {
    // 估算 12000 vs 实报 10000 → 偏差 +20.0%
    pillMocks.appState.contextHealth = makeHealth({
      tokenSource: 'provider',
      estimatedTokens: 12000,
    });
    openPopover();

    const deviation = screen.getByTestId('context-health-deviation');
    expect(deviation.textContent).toBe('Neo 的估算与实际用量有出入');
    expect(deviation.textContent).not.toMatch(/\d%/);
    expect(screen.queryByTestId('context-health-estimated-badge')).toBeNull();
  });

  it('provider 实报但偏差收敛到 0 时：不显示偏差（无信息量的噪声不出现在 UI）', () => {
    pillMocks.appState.contextHealth = makeHealth({
      tokenSource: 'provider',
      estimatedTokens: 10000,
    });
    openPopover();

    expect(screen.queryByTestId('context-health-deviation')).toBeNull();
    expect(screen.queryByTestId('context-health-estimated-badge')).toBeNull();
  });

  it('FB-117：4.9% 不标注，5% 起标注（门槛是百分点不是 0.05%）', () => {
    pillMocks.appState.contextHealth = makeHealth({
      tokenSource: 'provider',
      currentTokens: 10000,
      estimatedTokens: 10000 + 490,
    });
    openPopover();
    expect(screen.queryByTestId('context-health-deviation')).toBeNull();
    cleanup();

    pillMocks.appState.contextHealth = makeHealth({
      tokenSource: 'provider',
      currentTokens: 10000,
      estimatedTokens: 10500,
    });
    openPopover();
    expect(screen.getByTestId('context-health-deviation').textContent).toBe('Neo 的估算与实际用量有出入');
  });

  it.each(['zh', 'en'] as const)('plain language for a +280.6 percent estimate and no fee placeholder (%s)', (language) => {
    pillMocks.appState.language = language;
    pillMocks.appState.contextHealth = makeHealth({
      tokenSource: 'provider',
      currentTokens: 10000,
      estimatedTokens: 38060,
      systemPromptCacheCost: {
        status: 'known_cached', tokens: 1000, costUsd: 0.0001, inputCostPercent: 12,
      },
    });
    openPopover();
    const deviation = screen.getByTestId('context-health-deviation');
    expect(deviation.textContent).toBe(language === 'zh'
      ? 'Neo 的估算与实际用量有出入'
      : "Neo's estimate differs from actual usage");
    expect(deviation.textContent).not.toMatch(/\d%/);
    expect(deviation.title).toBe(language === 'zh'
      ? '此处显示模型服务商统计的实际用量，Neo 自己的估算与它有差距'
      : "The usage shown is the model service's actual count; Neo's own estimate differs.");
    const ranking = screen.getByTestId('context-cost-ranking-status');
    expect(ranking.textContent).toBe(language === 'zh' ? '占用最多：对话' : 'Most space used: Conversation');
    expect(screen.getByTestId('context-health-detail').textContent)
      .not.toMatch(/费用最多|Highest fee|待确认|To be confirmed/);
  });

  it.each(['zh', 'en'] as const)('provider-reported total stays authoritative despite a differing Neo estimate (%s)', (language) => {
    pillMocks.appState.language = language;
    pillMocks.appState.contextHealth = makeHealth({
      tokenSource: 'provider',
      currentTokens: 10000,
      estimatedTokens: 38060,
    });
    openPopover();

    const panel = screen.getByTestId('context-health-detail');
    expect(panel.textContent).toContain('10.0k / 100.0k Token');
    expect(panel.textContent).not.toContain('38.1k');
    expect(screen.queryByTestId('context-health-estimated-badge')).toBeNull();
    const deviation = screen.getByTestId('context-health-deviation');
    expect(deviation.textContent).toBe(language === 'zh'
      ? 'Neo 的估算与实际用量有出入'
      : "Neo's estimate differs from actual usage");
    expect(deviation.title).toBe(language === 'zh'
      ? '此处显示模型服务商统计的实际用量，Neo 自己的估算与它有差距'
      : "The usage shown is the model service's actual count; Neo's own estimate differs.");
    expect(deviation.textContent).not.toMatch(/\d%/);
  });

  it('clamps to composer space on open, window resize, container resize and reopen', () => {
    let composerLeft = 260;
    let ringRight = 500;
    let resized: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resized = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'context-health-detail') {
        // jsdom has no CSS layout: project the declared width into the mocked anchor space.
        const width = this.style.width ? Number.parseFloat(this.style.width)
          : this.classList.contains('w-[440px]') ? 440 : 0;
        return new DOMRect(ringRight - width, 300, width, 400);
      }
      if (this.tagName === 'FORM') return new DOMRect(composerLeft, 700, 650, 100);
      if (this.classList.contains('relative') && this.querySelector('button')) {
        return new DOMRect(ringRight - 32, 750, 32, 32);
      }
      return nativeRect.call(this);
    });
    pillMocks.appState.contextHealth = makeHealth({ tokenSource: 'provider' });
    openPopover();
    const assertInside = (expectedWidth: number) => {
      const panel = screen.getByTestId('context-health-detail');
      const rect = panel.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(composerLeft);
      expect(rect.right).toBeLessThanOrEqual(ringRight);
      expect(rect.width).toBe(expectedWidth);
      expect(panel.className).not.toContain('w-[440px]');
    };
    assertInside(240);
    ringRight = 450;
    act(() => window.dispatchEvent(new Event('resize')));
    assertInside(190);
    composerLeft = 300;
    act(() => resized?.([], {} as ResizeObserver));
    assertInside(150);
    ringRight = 1000;
    act(() => resized?.([], {} as ResizeObserver));
    assertInside(440);
    expect(observe).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(disconnect).toHaveBeenCalledTimes(1);
    ringRight = 600;
    fireEvent.click(screen.getByRole('button', { name: '上下文使用' }));
    assertInside(300);
  });

  it('窗口兜底：停用已用占比，标上限未获取', () => {
    pillMocks.appState.contextHealth = makeHealth({
      currentTokens: 153600,
      maxTokens: 128000,
      usagePercent: 120,
      windowKnown: false,
      tokenSource: 'provider',
      estimatedTokens: 40000,
    });
    openPopover();

    expect(screen.getByTestId('context-health-window-unknown').textContent).toContain('上限未获取');
    expect(screen.queryByText(/100% 已用/)).toBeNull();
    expect(screen.queryByText(/120% 已用/)).toBeNull();
  });

  it('tokenSource=estimated：显示「估算」标注，即使有 estimatedTokens 也不显示偏差', () => {
    pillMocks.appState.contextHealth = makeHealth({
      tokenSource: 'estimated',
      estimatedTokens: 12000,
    });
    openPopover();

    expect(screen.getByTestId('context-health-estimated-badge').textContent).toContain('估算');
    expect(screen.queryByTestId('context-health-deviation')).toBeNull();
  });

  it('老状态缺省 tokenSource：视同 estimated，显示「估算」标注', () => {
    pillMocks.appState.contextHealth = makeHealth({});
    openPopover();

    expect(screen.getByTestId('context-health-estimated-badge').textContent).toContain('估算');
  });
});
