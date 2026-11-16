import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

const NOTE = '「百科摘要」：后台任务做到第 3 步（上限 3 步）就用完了步数，还没有得出最终结果。';
const messages: Message[] = [
  { id: 'u', role: 'user', content: '在后台查百度百科', timestamp: 1 },
  { id: 'a', role: 'assistant', content: '好的，我已经安排好了', timestamp: 2 },
  {
    id: 'stop', role: 'system', content: NOTE, timestamp: 3,
    metadata: { backgroundTaskStopped: { taskId: 't1', kind: 'step_cap' } },
  },
];

describe('backgroundTaskStopped after a finished foreground turn', () => {
  it('is its own trailing turn and renders as a plain conclusion row, not italic process noise', () => {
    const turns = projectTurns(messages, 'session', false).turns;
    const last = turns[turns.length - 1];
    expect(last.nodes.map((n) => n.id)).toEqual(['stop']);
    expect(turns.slice(0, -1).flatMap((t) => t.nodes).some((n) => n.id === 'stop')).toBe(false);
    const html = renderToStaticMarkup(<TraceNodeRenderer node={last.nodes[0]} />);
    expect(html).toContain(NOTE);
    expect(html).toContain('data-testid="background-task-stopped-note"');
    expect(html).not.toContain('italic');
  });
});
