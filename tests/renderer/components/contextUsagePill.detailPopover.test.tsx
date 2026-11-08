// @vitest-environment jsdom
// ============================================================================
// ContextUsagePill — hover 气泡 / 点击开明细弹层 / context 深链（N-CTXPANEL 病A）
// 交互口径（2026-08-21 爸拍板）：hover 圆环出只读气泡，点击圆环展开长在输入框
// 上方的明细弹层（Cursor 同款不割裂形态）；分桶条/费用/压缩钮都在明细弹层里。
// 反向变异承重：删掉明细弹层挂载点，用例 2/4 必须红；
// 拿掉弹层顶部分桶条，用例 2 必须红。
// ============================================================================

import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_CONTEXT_HEALTH_EVENT } from '../../../src/renderer/utils/workbenchViews';
import type { ContextHealthState } from '../../../src/shared/contract/contextHealth';

const contextHealth: ContextHealthState = {
  currentTokens: 2000,
  maxTokens: 10000,
  usagePercent: 20,
  breakdown: {
    systemPrompt: 100,
    messages: 1900,
    toolResults: 0,
    bySource: {
      rules: 100,
      skills: { 'my-skill': 50 },
      mcp: {},
      subagents: {},
      fileReads: 0,
      summary: 200,
      conversation: 800,
    },
  },
  warningLevel: 'normal',
  estimatedTurnsRemaining: 10,
  lastUpdated: Date.now(),
  compression: { status: 'none', compressionCount: 2, totalSavedTokens: 5000 },
  systemPromptCacheCost: { status: 'unknown', tokens: 100 },
};

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
  budgetStatus: {
    enabled: false,
    currentCost: 0.26,
    maxBudget: 0,
    usagePercentage: 0,
    alertLevel: 'none' as const,
    cacheCostSplit: {
      cachedTokens: 8_000,
      uncachedTokens: 2_000,
      cachedCostUsd: 0.08,
      uncachedCostUsd: 0.18,
      cachedCostPercent: 30.8,
      uncachedCostPercent: 69.2,
    },
  },
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
  useBudgetStatus: () => pillMocks.budgetStatus,
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      currentSessionId: 'session-1',
      refreshContextHealth: pillMocks.refreshContextHealth,
    }),
  },
}));

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

function pillButton() {
  return screen.getByRole('button', { name: '上下文使用' });
}

function hoverPill() {
  // hover 处理挂在 wrapper div 上（onMouseEnter）；React 的 enter/leave 靠
  // mouseover/mouseout 冒泡合成，fireEvent.mouseEnter 不冒泡触发不到
  fireEvent.mouseOver(pillButton());
}

describe('ContextUsagePill — hover 气泡与明细弹层', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pillMocks.appState.language = 'zh';
    pillMocks.appState.contextHealth = contextHealth;
    useContextCompactionStore.setState({ status: 'idle', result: null, error: null, updatedAt: 0 });
  });

  afterEach(cleanup);

  it('hover 出只读气泡（% + token 数），气泡里没有分桶条和操作钮', () => {
    render(<ContextUsagePill />);
    hoverPill();

    expect(screen.getByText(/20% 已用/)).toBeTruthy();
    expect(screen.getByText(/2\.0k \/ 10\.0k Token/)).toBeTruthy();
    expect(screen.queryByTestId('context-source-bar')).toBeNull();
    expect(screen.queryByRole('button', { name: '立即压缩' })).toBeNull();
  });

  it('点击圆环直接打开明细弹层：分桶条 + 面板 bySource 区 + 摘要桶都在', () => {
    render(<ContextUsagePill />);
    fireEvent.click(pillButton());

    expect(screen.getByText('上下文健康度明细')).toBeTruthy();
    // 弹层顶部分桶条：摘要段 title 带名称/token/占比
    const bar = screen.getByTestId('context-source-bar');
    expect(bar.innerHTML).toContain('摘要（压了 2 轮）');
    expect(bar.innerHTML).toContain('200 Token');
    // 平铺桶清单（After 稿口径）：聚合类目中文名，0 值桶不占位
    const list = screen.getByTestId('context-bucket-list');
    expect(list.textContent).toContain('摘要（压了 2 轮）');
    expect(list.textContent).toContain('对话');
    expect(list.textContent).toContain('技能');
    expect(list.textContent).toContain('规则');
    expect(list.textContent).toContain('空间占用来源');
    expect(list.textContent).toContain('占用比例');
    expect(list.getAttribute('data-cost-column')).toBe('off');
    expect(list.textContent).not.toContain('费用占比');
    expect(list.textContent).not.toContain('未知');
    expect(screen.getByTestId('context-cost-ranking-status').textContent).toContain('占用最多');
    expect(screen.getByTestId('context-cost-ranking-status').textContent).not.toContain('待确认');
    expect(screen.getByTestId('context-health-window-caption').textContent).toContain('本窗口');
    expect(screen.getByTestId('context-bucket-share-caption').textContent).toContain('谁在占');
    const shares = [...bar.querySelectorAll('[data-share-percent]')].map((el) => Number(el.getAttribute('data-share-percent')));
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(100, 0);
    // fixture 里 mcp/subagents/fileReads 为 0 → 不占位
    expect(list.textContent).not.toContain('连接器');
    expect(list.textContent).not.toContain('子代理');
    expect(list.textContent).not.toContain('文件读取');
  });

  it('系统提示跨过判定门槛时并列展示 token 占比与 cacheRead 成本占比', () => {
    pillMocks.appState.contextHealth = {
      ...contextHealth,
      systemPromptCacheCost: {
        status: 'known_cached',
        tokens: 100,
        costUsd: 0.0001,
        inputCostPercent: 12.2,
      },
    };
    render(<ContextUsagePill />);
    fireEvent.click(pillButton());

    const list = screen.getByTestId('context-bucket-list');
    expect(list.getAttribute('data-cost-column')).toBe('on');
    expect(list.textContent).toContain('100 Token · 8.0%');
    expect(list.textContent).toContain('$0.0001 · 12.2%');
    expect(screen.getByTestId('context-cost-ranking-status').textContent).toContain('待确认');
  });

  it('现有上下文健康弹层展示当前周期已缓存 / 未缓存的 token 与成本两分', () => {
    render(<ContextUsagePill />);
    fireEvent.click(pillButton());

    const split = screen.getByTestId('context-cache-cost-split');
    expect(split.textContent).toContain('已复用（更省）');
    expect(split.textContent).toContain('8.0k Token · 80.0%');
    expect(split.textContent).toContain('$0.0800 · 30.8%');
    expect(split.textContent).toContain('新计算');
    expect(split.textContent).toContain('2.0k Token · 20.0%');
    expect(split.textContent).toContain('$0.1800 · 69.2%');
  });

  it('bySource 全 0 时来源桶不占位（结构桶仍在）', () => {
    pillMocks.appState.contextHealth = {
      ...contextHealth,
      breakdown: {
        ...contextHealth.breakdown,
        bySource: {
          rules: 0,
          skills: {},
          mcp: {},
          subagents: {},
          fileReads: 0,
          summary: 0,
          conversation: 0,
        },
      },
    };
    render(<ContextUsagePill />);
    fireEvent.click(pillButton());

    expect(screen.getByText('上下文健康度明细')).toBeTruthy();
    // bySource 全 0：来源桶不占位，但结构桶（系统提示 100）仍在清单里
    const list = screen.getByTestId('context-bucket-list');
    expect(list.textContent).toContain('Neo 基础设定');
    expect(list.textContent).not.toContain('对话');
  });

  it('context 深链（OPEN_CONTEXT_HEALTH_EVENT）直接打开明细弹层', () => {
    render(<ContextUsagePill />);

    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_CONTEXT_HEALTH_EVENT));
    });

    expect(screen.getByText('上下文健康度明细')).toBeTruthy();
    expect(screen.getByTestId('context-bucket-list')).toBeTruthy();
  });

  it('明细弹层里压缩入口沿用 ≥70% 门槛：20% 不显示，80% 显示', () => {
    render(<ContextUsagePill />);
    fireEvent.click(pillButton());
    expect(screen.queryByRole('button', { name: '立即压缩' })).toBeNull();
    cleanup();

    pillMocks.appState.contextHealth = { ...contextHealth, usagePercent: 80, warningLevel: 'warning' };
    render(<ContextUsagePill />);
    fireEvent.click(pillButton());
    expect(screen.getByRole('button', { name: '立即压缩' })).toBeTruthy();
  });

  it('窗口未知只停用已用占比，不拿掉手动压缩', () => {
    pillMocks.appState.contextHealth = {
      ...contextHealth,
      usagePercent: 80,
      warningLevel: 'warning',
      windowKnown: false,
    };
    render(<ContextUsagePill />);
    fireEvent.click(pillButton());
    expect(screen.getByTestId('context-health-window-unknown')).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即压缩' })).toBeTruthy();
  });

  it('① 窗口未知时：hover 气泡与按钮 title 无「容量未知 / Capacity unknown」搭配「x / max」的自相矛盾，无重复 badge 行（中英文）', () => {
    pillMocks.appState.contextHealth = {
      ...contextHealth,
      currentTokens: 15_360,
      maxTokens: 128_000,
      usagePercent: 12,
      windowKnown: false,
    };
    const { container } = render(<ContextUsagePill />);
    const btn = pillButton();
    const titleZh = btn.getAttribute('title') ?? '';
    expect(titleZh).toContain('已用约 15.4k Token');
    expect(titleZh).toContain('模型上限未获取，暂按 128.0k 估算');
    expect(titleZh).not.toContain('容量未知');
    expect(titleZh).not.toMatch(/15\.4k\s*\/\s*128\.0k/);

    hoverPill();
    const bubbleTextZh = container.textContent ?? '';
    expect(bubbleTextZh).toContain('已用约 15.4k Token');
    expect(bubbleTextZh).toContain('模型上限未获取，暂按 128.0k 估算');
    expect(bubbleTextZh).not.toContain('容量未知');
    expect(bubbleTextZh).not.toMatch(/15\.4k\s*\/\s*128\.0k/);

    fireEvent.click(btn);
    const unknownBadgeZh = screen.getByTestId('context-health-window-unknown').textContent ?? '';
    expect(unknownBadgeZh).toBe('模型上限未获取，暂按 128.0k 估算');
    const detailZhText = screen.getByTestId('context-health-detail').textContent ?? '';
    expect(detailZhText.split('模型上限未获取，暂按 128.0k 估算').length - 1).toBe(1);
    cleanup();

    pillMocks.appState.language = 'en';
    const { container: containerEn } = render(<ContextUsagePill />);
    const btnEn = screen.getByRole('button', { name: 'Context usage' });
    const titleEn = btnEn.getAttribute('title') ?? '';
    expect(titleEn).toContain('About 15.4k Token used');
    expect(titleEn).toContain('Model limit unavailable; estimating against 128.0k');
    expect(titleEn).not.toContain('Capacity unknown');
    expect(titleEn).not.toMatch(/15\.4k\s*\/\s*128\.0k/);

    fireEvent.mouseOver(btnEn);
    const bubbleTextEn = containerEn.textContent ?? '';
    expect(bubbleTextEn).toContain('About 15.4k Token used');
    expect(bubbleTextEn).toContain('Model limit unavailable; estimating against 128.0k');
    expect(bubbleTextEn).not.toContain('Capacity unknown');
    expect(bubbleTextEn).not.toMatch(/15\.4k\s*\/\s*128\.0k/);

    fireEvent.click(btnEn);
    const unknownBadgeEn = screen.getByTestId('context-health-window-unknown').textContent ?? '';
    expect(unknownBadgeEn).toBe('Model limit unavailable; estimating against 128.0k');
    const detailEnText = screen.getByTestId('context-health-detail').textContent ?? '';
    expect(detailEnText.split('Model limit unavailable; estimating against 128.0k').length - 1).toBe(1);
  });

  it('② 同一 ContextHealthState 在按钮 title、气泡、明细弹层（含各桶与缓存行）显示相同读数且均带 Token 单位，无裸数字', () => {
    const unifiedState: ContextHealthState = {
      currentTokens: 15_360,
      maxTokens: 128_000,
      usagePercent: 12,
      breakdown: {
        systemPrompt: 21,
        messages: 15_339,
        toolResults: 0,
        toolDefinitions: 450,
        bySource: {
          rules: 85,
          skills: { s1: 21 },
          mcp: {},
          subagents: {},
          fileReads: 0,
          summary: 0,
          conversation: 14_783,
        },
      },
      warningLevel: 'normal',
      estimatedTurnsRemaining: 10,
      lastUpdated: Date.now(),
    };
    pillMocks.appState.contextHealth = unifiedState;
    const { container } = render(<ContextUsagePill />);
    const btn = pillButton();
    expect(btn.getAttribute('title')).toContain('15.4k/128.0k Token');

    hoverPill();
    expect(container.textContent).toContain('15.4k / 128.0k Token');

    fireEvent.click(btn);
    const detail = screen.getByTestId('context-health-detail');
    expect(detail.textContent).toContain('15.4k / 128.0k Token');

    const list = screen.getByTestId('context-bucket-list');
    expect(list.textContent).toContain('21 Token ·');
    expect(list.textContent).toContain('450 Token ·');
    expect(list.textContent).toContain('85 Token ·');
    expect(list.textContent).toContain('14.8k Token ·');
    // 桶行与缓存行中不得出现「数字直接跟 ·」而没有 Token 单位的裸数字
    expect(list.textContent).not.toMatch(/\b\d+(?:\.\d+)?[kM]?\s*·\s*\d+\.\d+%/);

    const split = screen.getByTestId('context-cache-cost-split');
    expect(split.textContent).toContain('8.0k Token · 80.0%');
    expect(split.textContent).toContain('2.0k Token · 20.0%');
  });

  it('③ 明细弹层（窗口已知与未知、中英文）不含旧工程黑话，且包含「这意味着什么」说明行', () => {
    const oldZhTerms = [
      '上下文桶',
      'Token 占比',
      '成本占比',
      '整体输入缓存成本',
      '已缓存',
      '未缓存',
      '估算偏差',
      '待验证',
      '系统提示',
      '工具定义',
    ];
    const oldEnTerms = [
      'Context bucket',
      'Token share',
      'Cost share',
      'Overall input cache cost',
      'Est. deviation',
      'Pending validation',
      'System Prompt',
      'Tool Defs',
    ];

    const stateBase: ContextHealthState = {
      ...contextHealth,
      currentTokens: 10_000,
      maxTokens: 100_000,
      usagePercent: 10,
      tokenSource: 'provider',
      estimatedTokens: 12_000,
      breakdown: {
        ...contextHealth.breakdown,
        systemPrompt: 500,
        toolDefinitions: 300,
      },
      systemPromptCacheCost: {
        status: 'known_cached',
        tokens: 500,
        costUsd: 0.0005,
        inputCostPercent: 15.0,
      },
    };

    for (const windowKnown of [true, false]) {
      pillMocks.appState.language = 'zh';
      pillMocks.appState.contextHealth = { ...stateBase, usagePercent: 10, windowKnown };
      render(<ContextUsagePill />);
      fireEvent.click(pillButton());
      const detailZh = screen.getByTestId('context-health-detail').textContent ?? '';
      for (const term of oldZhTerms) {
        expect(detailZh).not.toContain(term);
      }
      expect(screen.queryByRole('button', { name: '立即压缩' })).toBeNull();
      const whatZhLow = screen.getByTestId('context-health-what-this-means').textContent ?? '';
      expect(whatZhLow).toContain(
        windowKnown
          ? '快满时 Neo 会自动整理较早的对话。'
          : '上限未获取，Neo 仍会在接近上限时自动整理较早的对话。',
      );
      expect(whatZhLow).not.toContain('立即压缩');
      cleanup();

      pillMocks.appState.contextHealth = { ...stateBase, usagePercent: 75, warningLevel: 'warning', windowKnown };
      render(<ContextUsagePill />);
      fireEvent.click(pillButton());
      expect(screen.getByRole('button', { name: '立即压缩' })).toBeTruthy();
      expect(screen.getByTestId('context-health-what-this-means').textContent).toContain(
        windowKnown
          ? '快满时 Neo 会自动整理较早的对话；想现在整理，点「立即压缩」。'
          : '上限未获取，Neo 仍会在接近上限时自动整理较早的对话；想现在整理，点「立即压缩」。',
      );
      cleanup();

      pillMocks.appState.language = 'en';
      pillMocks.appState.contextHealth = { ...stateBase, usagePercent: 10, windowKnown };
      render(<ContextUsagePill />);
      fireEvent.click(screen.getByRole('button', { name: 'Context usage' }));
      const detailEn = screen.getByTestId('context-health-detail').textContent ?? '';
      for (const term of oldEnTerms) {
        expect(detailEn).not.toContain(term);
      }
      expect(detailEn).toContain('Reused (cheaper)');
      expect(detailEn).toContain('New calculation');
      expect(screen.queryByRole('button', { name: 'Compact now' })).toBeNull();
      const whatEnLow = screen.getByTestId('context-health-what-this-means').textContent ?? '';
      expect(whatEnLow).toContain(
        windowKnown
          ? 'When it gets close to full, Neo tidies older conversation automatically.'
          : 'Limit unavailable; Neo still tidies older conversation automatically when it gets close to full.',
      );
      expect(whatEnLow).not.toContain('Compact now');
      cleanup();

      pillMocks.appState.contextHealth = { ...stateBase, usagePercent: 75, warningLevel: 'warning', windowKnown };
      render(<ContextUsagePill />);
      fireEvent.click(screen.getByRole('button', { name: 'Context usage' }));
      expect(screen.getByRole('button', { name: 'Compact now' })).toBeTruthy();
      expect(screen.getByTestId('context-health-what-this-means').textContent).toContain(
        windowKnown
          ? 'When it gets close to full, Neo tidies older conversation automatically; to tidy now, click "Compact now".'
          : 'Limit unavailable; Neo still tidies older conversation automatically when it gets close to full. To tidy now, click "Compact now".',
      );
      cleanup();
    }
  });
});
