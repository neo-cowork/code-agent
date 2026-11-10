// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';

vi.mock('../../../src/renderer/components/features/chat/TraceNodeRenderer', () => ({
  TraceNodeRenderer: ({ node }: { node: { type: string; content?: string } }) => (
    React.createElement('div', null, node.content || node.type)
  ),
}));

vi.mock('../../../src/renderer/components/features/chat/StreamingIndicator', () => ({
  StreamingIndicator: () => React.createElement('div', { 'data-testid': 'streaming-indicator' }),
  getRunningToolStartTime: () => undefined,
  getRunningSubagentCount: () => 0,
  getStreamingWaitingReason: () => undefined,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', null, 'tool group'),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const baseTime = 1_800_000_000_000;

function reasoningNode(id: string, reasoning: string, timestamp = baseTime, content = ''): TraceTurn['nodes'][number] {
  return { id, type: 'assistant_text', content, timestamp, reasoning } as TraceTurn['nodes'][number];
}

function toolNode(id: string, timestamp: number): TraceTurn['nodes'][number] {
  return {
    id,
    type: 'tool_call',
    content: '',
    timestamp,
    toolCall: { id: `${id}-call`, name: 'Bash', args: {}, success: true, result: 'ok' },
  } as TraceTurn['nodes'][number];
}

function makeTurn(nodes: TraceTurn['nodes'], status: TraceTurn['status'] = 'streaming'): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status,
    startTime: baseTime - 1_000,
    endTime: status === 'completed' ? baseTime + 5_000 : undefined,
    nodes: [
      { id: 'user-1', type: 'user', content: '帮我查一下', timestamp: baseTime - 1_000 },
      ...nodes,
    ],
  };
}

function getThinkingToggle(): HTMLButtonElement {
  return screen.getByTestId('thinking-digest').querySelector('button') as HTMLButtonElement;
}

function getContent(): HTMLElement {
  return screen.getByTestId('thinking-digest').querySelector('.thinking-digest-content') as HTMLElement;
}

describe('TurnCard 思考展示状态机', () => {
  it('流式 reasoning 期间默认收起，只显示「正在思考」一行，思考块独占该信号', () => {
    vi.setSystemTime(baseTime + 2_300);
    render(<TurnCard turn={makeTurn([reasoningNode('reasoning-1', '正在核对文件结构。')])} />);

    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('false');
    expect(getThinkingToggle().textContent).toContain('正在思考… · 3s');
    expect(getContent().getAttribute('aria-hidden')).toBe('true');
    expect(getContent().className).not.toContain('is-expanded');
    expect(screen.getByTestId('streaming-indicator').textContent).toBe('');
  });

  it('用户展开后，新文本、工具隔断后的新段、正文与回合完成都不再改动状态', () => {
    vi.setSystemTime(baseTime + 1_000);
    const first = reasoningNode('reasoning-1', '第一段。');
    const { rerender } = render(<TurnCard turn={makeTurn([first])} />);

    fireEvent.click(getThinkingToggle());
    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('true');
    expect(getContent().getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByText('第一段。')).not.toBeNull();
    expect(screen.getByTestId('thinking-digest').getAttribute('data-user-interacted')).toBe('true');

    const expectOpen = () => {
      expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByTestId('thinking-digest').getAttribute('data-user-interacted')).toBe('true');
    };

    rerender(<TurnCard turn={makeTurn([{ ...first, reasoning: '第一段。继续推理。' }])} />);
    expectOpen();
    expect(screen.getByText('第一段。继续推理。')).not.toBeNull();

    const withTool = [first, toolNode('tool-1', baseTime + 2_000)];
    rerender(<TurnCard turn={makeTurn(withTool)} />);
    expectOpen();

    const withSecond = [...withTool, reasoningNode('reasoning-2', '第二段。', baseTime + 3_000)];
    rerender(<TurnCard turn={makeTurn(withSecond)} />);
    expectOpen();
    expect(screen.getByText('2. 第二段。')).not.toBeNull();

    rerender(<TurnCard turn={makeTurn([...withSecond, reasoningNode('answer-1', '', baseTime + 4_000, '正文')])} />);
    expectOpen();

    rerender(<TurnCard turn={makeTurn([...withSecond, reasoningNode('answer-1', '', baseTime + 4_000, '正文')], 'completed')} />);
    expectOpen();
    expect(getThinkingToggle().textContent).toContain('思考');
  });

  it('用户手动展开再收起后，正文、工具隔断、新 reasoning 段与回合完成都保持收起', () => {
    vi.setSystemTime(baseTime + 1_000);
    const first = reasoningNode('reasoning-1', '第一段。');
    const { rerender } = render(<TurnCard turn={makeTurn([first])} />);

    fireEvent.click(getThinkingToggle());
    fireEvent.click(getThinkingToggle());
    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('thinking-digest').getAttribute('data-user-interacted')).toBe('true');

    const expectClosed = () => {
      expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('false');
      expect(screen.getByTestId('thinking-digest').getAttribute('data-user-interacted')).toBe('true');
    };

    rerender(<TurnCard turn={makeTurn([{ ...first, content: '正文一' }])} />);
    expectClosed();

    const later = [
      { ...first, content: '正文一' },
      toolNode('tool-1', baseTime + 2_000),
      reasoningNode('reasoning-2', '第二段。', baseTime + 3_000),
    ];
    rerender(<TurnCard turn={makeTurn(later)} />);
    expectClosed();

    rerender(<TurnCard turn={makeTurn(later, 'completed')} />);
    expectClosed();
  });

  it('未交互时，工具隔断、新 reasoning 段与正文出现都保持收起', () => {
    vi.setSystemTime(baseTime + 1_000);
    const first = reasoningNode('reasoning-1', '第一段。');
    const { rerender } = render(<TurnCard turn={makeTurn([first])} />);
    const expectClosed = () => {
      expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('false');
      expect(screen.getByTestId('thinking-digest').getAttribute('data-user-interacted')).toBe('false');
    };
    expectClosed();

    rerender(<TurnCard turn={makeTurn([first, toolNode('tool-1', baseTime + 2_000)])} />);
    expectClosed();

    rerender(<TurnCard turn={makeTurn([
      first,
      toolNode('tool-1', baseTime + 2_000),
      reasoningNode('reasoning-2', '第二段。', baseTime + 3_000),
    ])} />);
    expectClosed();
    expect(getThinkingToggle().textContent).toContain('正在思考');
  });

  it('已完成的回合默认收起，显示带时长和段数的摘要', () => {
    render(<TurnCard turn={makeTurn([
      { ...reasoningNode('reasoning-1', '完整思考。'), content: '正文' } as TraceTurn['nodes'][number],
    ], 'completed')} />);
    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('false');
    expect(getThinkingToggle().textContent).toContain('思考 5s · 1 段');
  });

  it('provider 完全没有 reasoning delta 时不出现空思考块', () => {
    render(<TurnCard turn={makeTurn([
      reasoningNode('answer-1', '', baseTime, '直接输出正文'),
    ])} />);
    expect(screen.queryByTestId('thinking-digest')).toBeNull();
  });

  it('prefers-reduced-motion 下滚动跟随使用直达模式', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    render(<TurnCard turn={makeTurn([reasoningNode('reasoning-1', '直接展示。')])} />);

    const scroller = screen.getByTestId('thinking-digest').querySelector<HTMLElement>(
      '.thinking-digest-scroller',
    );
    expect(scroller?.style.scrollBehavior).toBe('auto');
  });

  it('手动展开完成态后，自动逻辑不再把它收回去', () => {
    const completed = makeTurn([
      reasoningNode('reasoning-1', '完整思考。'),
      toolNode('tool-1', baseTime + 2_000),
      reasoningNode('answer-1', '', baseTime + 3_000, '正文'),
    ], 'completed');
    render(<TurnCard turn={completed} defaultExpanded />);

    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(getThinkingToggle());
    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('thinking-digest').getAttribute('data-user-interacted')).toBe('true');
  });
});

describe('思考容器贴底判定', () => {
  it('距底 2px 以内跟随，用户上滚到 3px 后停止抢滚动', () => {
    const firstReasoning = reasoningNode('reasoning-1', '第一行');
    const { rerender } = render(<TurnCard turn={makeTurn([firstReasoning])} />);
    fireEvent.click(getThinkingToggle());
    const scroller = screen.getByTestId('thinking-digest').querySelector<HTMLElement>(
      '.thinking-digest-scroller',
    )!;
    let scrollHeight = 100;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 20 });

    scroller.scrollTop = 78;
    fireEvent.scroll(scroller);
    scrollHeight = 120;
    rerender(<TurnCard turn={makeTurn([{ ...firstReasoning, reasoning: '第一行\n第二行' }])} />);
    expect(scroller.scrollTop).toBe(120);

    scroller.scrollTop = 97;
    fireEvent.scroll(scroller);
    scrollHeight = 140;
    rerender(<TurnCard turn={makeTurn([{ ...firstReasoning, reasoning: '第一行\n第二行\n第三行' }])} />);
    expect(scroller.scrollTop).toBe(97);
  });
});
