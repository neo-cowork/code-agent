// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';

vi.mock('../../../src/renderer/components/features/chat/TraceNodeRenderer', () => ({
  TraceNodeRenderer: ({ node }: { node: { type: string; content?: string } }) => (
    React.createElement('div', null, node.content || node.type)
  ),
}));
vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));
vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', null, 'tool group'),
}));

import { useAppStore } from '../../../src/renderer/stores/appStore';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh', pendingPermissionRequest: null, pendingPermissionSessionId: null, queuedPermissionRequests: {} });
  vi.useRealTimers();
});

const baseTime = 1_800_000_000_000;

function makeTurn(nodes: TraceTurn['nodes'], status: TraceTurn['status'] = 'streaming'): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status,
    startTime: baseTime - 12_000,
    endTime: status === 'completed' ? baseTime : undefined,
    nodes: [{ id: 'user-1', type: 'user', content: '总结笔记', timestamp: baseTime - 12_000 }, ...nodes],
  };
}

const runningTool = {
  id: 'tool-1', type: 'tool_call', content: '', timestamp: baseTime - 5_000,
  toolCall: { id: 'c1', name: 'Read', args: {} },
} as TraceTurn['nodes'][number];

describe('TurnCard 重开运行中会话的合成「正在思考」行', () => {
  it('无思考文本时渲染单个收起行：带秒数、无箭头、无可点击按钮，且让出底部等待文案', () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    render(<TurnCard turn={makeTurn([])} />);
    const banners = screen.getAllByTestId('thinking-digest');
    expect(banners).toHaveLength(1);
    expect(banners[0].textContent).toMatch(/^正在思考… · \d+s$/);
    expect(banners[0].textContent).toContain('12s');
    expect(banners[0].querySelector('button')).toBeNull();
    expect(banners[0].querySelector('svg.lucide-chevron-right, svg.lucide-chevron-down')).toBeNull();
    expect(document.querySelector('.streaming-caret')).toBeNull();
    expect(screen.queryByText(/正在准备|Preparing/)).toBeNull();
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(screen.getByTestId('thinking-digest').textContent).toContain('15s');
  });

  it('有思考文本时保持原行为：可展开，后续更新仍保持展开', () => {
    const reasoning = { id: 'r1', type: 'assistant_text', content: '', timestamp: baseTime, reasoning: '核对文件。' } as TraceTurn['nodes'][number];
    const { rerender } = render(<TurnCard turn={makeTurn([reasoning])} />);
    const toggle = () => screen.getByTestId('thinking-digest').querySelector('button') as HTMLButtonElement;
    act(() => { toggle().click(); });
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    rerender(<TurnCard turn={makeTurn([{ ...reasoning, reasoning: '核对文件。继续。' } as TraceTurn['nodes'][number]])} />);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('thinking-digest').getAttribute('data-synthetic')).toBeNull();
  });

  it('工具运行中不渲染合成行', () => {
    render(<TurnCard turn={makeTurn([runningTool])} />);
    expect(screen.queryByTestId('thinking-digest')).toBeNull();
  });

  it('等待审批时不渲染合成行', () => {
    useAppStore.setState({ pendingPermissionSessionId: 's-1', pendingPermissionRequest: {
      id: 'p1', type: 'file_write', tool: 'Write', details: { path: 'a.md' }, timestamp: 1,
    } });
    render(<TurnCard turn={makeTurn([])} sessionId="s-1" />);
    expect(screen.queryByTestId('thinking-digest')).toBeNull();
  });

  it('已完成回合不渲染合成行', () => {
    render(<TurnCard turn={makeTurn([], 'completed')} />);
    expect(screen.queryByTestId('thinking-digest')).toBeNull();
  });

  for (const tool of ['Write', 'Edit']) {
    it(`思考段之后跟着已完成的独立 ${tool} 节点、等模型继续时，底部仍显示「正在整理回复」`, () => {
      const reasoning = { id: 'r1', type: 'assistant_text', content: '', timestamp: baseTime - 8_000, reasoning: '先改文件。' } as TraceTurn['nodes'][number];
      const done = {
        id: 'tool-done', type: 'tool_call', content: '', timestamp: baseTime - 5_000,
        toolCall: { id: 'c-done', name: tool, args: { file_path: 'a.md' }, result: 'ok', success: true },
      } as TraceTurn['nodes'][number];
      render(<TurnCard turn={makeTurn([reasoning, done])} />);
      expect(screen.getByTestId('thinking-digest').getAttribute('data-synthetic')).toBeNull();
      expect(screen.getByTestId('streaming-preparation-indicator').textContent).toContain('正在整理回复');
    });
  }
});
