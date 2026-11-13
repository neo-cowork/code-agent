// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';

vi.mock('../../../src/renderer/components/features/chat/TraceNodeRenderer', () => ({
  TraceNodeRenderer: ({
    node,
  }: {
    node: { type: string; content?: string };
  }) => React.createElement('div', { 'data-testid': `node-${node.type}` }, node.content),
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', { 'data-testid': 'tool-running' }, 'tool running'),
}));

import { turnPhaseFallbackLabel } from '../../../src/renderer/utils/turnPhaseFallback';
import { languages } from '../../../src/renderer/i18n';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const baseTime = 1_800_000_000_000;

function makeTurn(nodes: TraceTurn['nodes']): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'streaming',
    startTime: baseTime - 1_000,
    nodes: [
      { id: 'user-1', type: 'user', content: '处理一下', timestamp: baseTime - 1_000 },
      ...nodes,
    ],
  };
}

function completedTool(): TraceTurn['nodes'][number] {
  return {
    id: 'tool-completed',
    type: 'tool_call',
    content: '',
    timestamp: baseTime,
    toolCall: { id: 'call-completed', name: 'Read', args: {}, result: 'ok', success: true },
  };
}

function getStreamingCarets(): NodeListOf<Element> {
  return document.querySelectorAll('.streaming-caret');
}

describe('TurnCard busy signal', () => {
  it('思考阶段只渲染正在思考头，不渲染流式光标', () => {
    vi.setSystemTime(baseTime + 2_300);
    render(<TurnCard turn={makeTurn([
      completedTool(),
      {
        id: 'thinking-1',
        type: 'assistant_text',
        content: '',
        reasoning: '正在核对约束。',
        timestamp: baseTime + 100,
      },
    ])} />);

    expect(screen.getByText(/正在思考… · 3s/)).toBeTruthy();
    expect(getStreamingCarets()).toHaveLength(0);
  });

  it('文本流式阶段只渲染文本尾光标，思考头不带正在态', () => {
    vi.setSystemTime(baseTime + 2_300);
    render(<TurnCard turn={makeTurn([{
      id: 'answer-1',
      type: 'assistant_text',
      content: '开始输出正文',
      reasoning: '已经完成分析。',
      timestamp: baseTime,
    }])} />);

    const carets = getStreamingCarets();
    const answer = screen.getByTestId('node-assistant_text');
    expect(carets).toHaveLength(1);
    expect(answer.compareDocumentPosition(carets[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('streaming-preparation-indicator')).toBeNull();
    expect(screen.queryByText(/正在思考/)).toBeNull();
  });

  it('工具完成后等待出字时，文字指示跟在步骤组之后且轮头无裸光标', () => {
    render(<TurnCard turn={makeTurn([
      completedTool(),
      {
        id: 'synthetic-tail',
        type: 'assistant_text',
        content: '',
        timestamp: baseTime + 100,
      },
    ])} />);

    const toolGroup = screen.getByTestId('tool-running');
    const indicator = screen.getByTestId('streaming-preparation-indicator');
    expect(indicator.getAttribute('data-preparation-phase')).toBe('organizing');
    expect(indicator.textContent).toContain('正在整理回复');
    expect(toolGroup.compareDocumentPosition(indicator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getStreamingCarets()).toHaveLength(0);
  });

  it('durable 回合已启动且尚无首 token 时，轮头如实显示等待模型', () => {
    render(<TurnCard turn={makeTurn([])} />);

    expect(screen.getByText('信号传输中，正在等待模型回响…')).toBeTruthy();
    expect(screen.queryByTestId('streaming-preparation-indicator')).toBeNull();
    expect(screen.queryByTestId('tool-running')).toBeNull();
    expect(getStreamingCarets()).toHaveLength(0);
  });

  it('外层首轮占位可见时，活动 turn 不再渲染第二条忙信号', () => {
    render(<TurnCard turn={makeTurn([])} suppressBusySignal />);

    expect(screen.queryByText('信号传输中，正在等待模型回响…')).toBeNull();
    expect(screen.queryByTestId('streaming-preparation-indicator')).toBeNull();
    expect(getStreamingCarets()).toHaveLength(0);
  });

  it('工具执行阶段由步骤行独占进行中态，思考头和光标都不渲染', () => {
    render(<TurnCard turn={makeTurn([
      {
        id: 'tool-running',
        type: 'tool_call',
        content: '',
        timestamp: baseTime,
        toolCall: { id: 'call-running', name: 'Bash', args: {} },
      },
      {
        id: 'synthetic-tail',
        type: 'assistant_text',
        content: '',
        timestamp: baseTime + 100,
      },
    ])} />);

    expect(screen.getByTestId('tool-running')).toBeTruthy();
    expect(screen.queryByText(/正在思考/)).toBeNull();
    expect(getStreamingCarets()).toHaveLength(0);
  });
});

// N-FIX-SIGNED-OUT-SEND-500-RAW-HTML-REDESIGN：发送失败的轮（用户气泡 sendFailed）
// 的轮头阶段不许再标「回复已生成」——失败句旁边挂“已生成”自相矛盾；文案改走
// t.turnRun（zh/en），不再硬编码中文。
describe('TurnCard 轮头阶段兜底（发送失败轮）', () => {
  it('sendFailed 轮不显示「回复已生成」，未失败轮仍显示', () => {
    const failedTurn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-failed-send',
      status: 'error',
      startTime: baseTime - 1_000,
      nodes: [
        {
          id: 'user-send',
          type: 'user',
          content: '帮我把下载文件夹里的照片按日期改名',
          timestamp: baseTime - 1_000,
          metadata: { sendFailed: true },
        },
        {
          id: 'fail-sentence',
          type: 'assistant_text',
          content: '这个项目文件夹需要你确认后 Neo 才能使用。',
          timestamp: baseTime,
        },
      ],
    };
    const { unmount } = render(<TurnCard turn={failedTurn} />);
    const failedHeader = screen.getByTestId('turn-run-header');
    expect(failedHeader.textContent).toContain('遇到问题');
    expect(failedHeader.textContent).not.toContain('回复已生成');
    expect(failedHeader.textContent).not.toContain('等待输出');
    unmount();

    const normalTurn: TraceTurn = {
      ...failedTurn,
      turnId: 'turn-normal',
      status: 'completed',
      nodes: [
        { id: 'user-ok', type: 'user', content: '处理一下', timestamp: baseTime - 1_000 },
        { id: 'answer-ok', type: 'assistant_text', content: '已经完成。', timestamp: baseTime },
      ],
    };
    render(<TurnCard turn={normalTurn} />);
    expect(screen.queryByTestId('turn-run-header')).toBeNull();
    expect(turnPhaseFallbackLabel(normalTurn, languages.zh)).toBe('回复已生成');
  });

  it('en 语言下兜底显示 Reply generated，而不是硬编码中文', async () => {
    const { useAppStore } = await import('../../../src/renderer/stores/appStore');
    const original = useAppStore.getState().language;
    useAppStore.setState({ language: 'en' });
    try {
      const normalTurn: TraceTurn = {
        turnNumber: 1,
        turnId: 'turn-normal-en',
        status: 'completed',
        startTime: baseTime - 1_000,
        nodes: [
          { id: 'user-ok', type: 'user', content: 'do it', timestamp: baseTime - 1_000 },
          { id: 'answer-ok', type: 'assistant_text', content: 'Done.', timestamp: baseTime },
        ],
      };
      render(<TurnCard turn={normalTurn} />);
      expect(screen.queryByTestId('turn-run-header')).toBeNull();
      expect(turnPhaseFallbackLabel(normalTurn, languages.en)).toBe('Reply generated');
    } finally {
      useAppStore.setState({ language: original });
    }
  });
});

describe('TurnCard failed phase fallback', () => {
  it('suppresses the fallback for sendFailed even when the projected turn is completed', () => {
    const turn: TraceTurn = { ...makeTurn([]), status: 'completed' };
    turn.nodes[0].metadata = { sendFailed: true };
    expect(turnPhaseFallbackLabel(turn, languages.zh)).toBeNull();
    turn.nodes.push({ id: 'error-copy', type: 'assistant_text', content: 'The message could not be sent.', timestamp: baseTime });
    expect(turnPhaseFallbackLabel(turn, languages.en)).toBeNull();
  });
  it.each(['status', 'timeline'] as const)('omits success wording for %s errors with assistant text', (failure) => {
    const turn: TraceTurn = {
      ...makeTurn([{ id: 'partial', type: 'assistant_text', content: 'I started summarizing the meeting.', timestamp: baseTime }]),
      status: failure === 'status' ? 'error' : 'completed',
    };
    if (failure === 'timeline') turn.nodes.push({
      id: 'failure', type: 'turn_timeline', content: '', timestamp: baseTime,
      turnTimeline: { id: 'failure', kind: 'capability_scope', timestamp: baseTime, tone: 'error' },
    });
    expect(turnPhaseFallbackLabel(turn, languages.zh)).toBeNull();
    expect(turnPhaseFallbackLabel(turn, languages.en)).toBeNull();
    render(<TurnCard turn={turn} />);
    const header = screen.getByTestId('turn-run-header');
    expect(header.textContent).toContain('遇到问题');
    expect(header.textContent).not.toMatch(/回复已生成|Reply generated|completed|等待输出/);
  });

  it('does not display a completed header while waiting for the first token', () => {
    render(<TurnCard turn={makeTurn([])} />);
    expect(screen.queryByTestId('turn-run-header')).toBeNull();
    expect(screen.getByText('信号传输中，正在等待模型回响…')).toBeTruthy();
  });
});
