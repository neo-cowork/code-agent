// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';

vi.mock('../../../src/renderer/components/features/chat/TraceNodeRenderer', () => ({
  TraceNodeRenderer: ({ node }: { node: { type: string; content?: string } }) => (
    React.createElement('div', null, node.content || node.type)
  ),
}));
vi.mock('../../../src/renderer/components/features/chat/StreamingIndicator', () => ({
  StreamingIndicator: () => null,
  getRunningToolStartTime: () => undefined,
  getRunningSubagentCount: () => 0,
  getStreamingWaitingReason: () => undefined,
}));
vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => React.createElement('div', { 'data-testid': 'turn-diff-summary' }),
}));
vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', null, 'tool group'),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

afterEach(cleanup);
const t0 = 1_800_000_000_000;

function turnWith(extra: TraceTurn['nodes'][number]): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: t0,
    endTime: t0 + 5_000,
    nodes: [
      { id: 'u', type: 'user', content: '改文件', timestamp: t0 },
      { id: 'a', type: 'assistant_text', content: '已改完', timestamp: t0 + 1 },
      extra,
    ],
  } as TraceTurn;
}

describe('TurnCard 光杆停止提示节点不压掉改动摘要', () => {
  it('bare 提示节点（空正文 + user 中断原因）时仍渲染 TurnDiffSummary', () => {
    render(<TurnCard turn={turnWith({
      id: 'm-text', type: 'assistant_text', content: '', timestamp: t0 + 2,
      metadata: { streamInterruptionReason: 'user' },
    } as TraceTurn['nodes'][number])} />);
    expect(screen.queryByTestId('turn-diff-summary')).not.toBeNull();
  });

  it('真正的断流节点（带 streamRecovery）仍隐藏 TurnDiffSummary', () => {
    render(<TurnCard turn={turnWith({
      id: 'r', type: 'assistant_text', content: '', timestamp: t0 + 2,
      metadata: { streamInterruptionReason: 'app-restart', streamRecovery: { kind: 'x' } },
    } as unknown as TraceTurn['nodes'][number])} />);
    expect(screen.queryByTestId('turn-diff-summary')).toBeNull();
  });
});
