// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import fixture from '../fixtures/failedBackgroundSpawn.json';

const runtime = vi.hoisted(() => ({ invokeDomain: vi.fn() }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain: runtime.invokeDomain, invoke: vi.fn().mockResolvedValue([]) } }));
vi.mock('../../../src/renderer/hooks/useI18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/hooks/useI18n')>();
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { ...actual, useI18n: () => ({ t: zh, language: 'zh' }) };
});
// Only replace viewport measurement; the production turn and node renderers stay real.
vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(function Viewport(props: {
    data: TraceTurn[]; firstItemIndex: number;
    itemContent: (index: number, turn: TraceTurn) => React.ReactNode;
  }, ref) {
    React.useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn(), autoscrollToBottom: vi.fn() }));
    return <div>{props.data.map((turn, index) => <React.Fragment key={turn.turnId}>
      {props.itemContent(props.firstItemIndex + index, turn)}
    </React.Fragment>)}</div>;
  }),
}));

import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { mergeSnapshotWithLiveTail } from '../../../src/renderer/stores/sessionSnapshotMerge';
import { TurnBasedTraceView } from '../../../src/renderer/components/features/chat/TurnBasedTraceView';
import { useAppStore } from '../../../src/renderer/stores/appStore';

afterEach(() => { cleanup(); vi.useRealTimers(); runtime.invokeDomain.mockReset(); });

// Captured from the dogfood sales.csv run: empty text part, spawn_agent, thinking, agentError.
// Only unrelated metadata was omitted and the isolated workspace path was anonymized.
const messages = fixture as Message[];
const sessionId = 'session-sales-failure';

it('projects one error carrier and unique node IDs after repeated real snapshot/live-tail merges', () => {
  const failed = messages.find((message) => message.metadata?.agentError)!;
  expect(failed.content).toBe('');
  expect(failed.toolCalls?.[0].name).toBe('spawn_agent');
  expect(failed.contentParts?.some((part) => part.type === 'tool_call')).toBe(true);
  let live = structuredClone(messages);
  for (let poll = 0; poll <= 12; poll++) {
    live = mergeSnapshotWithLiveTail(messages, live).messages;
    expect(live).toHaveLength(messages.length);
    const nodes = projectTurns(live, sessionId, false).turns.flatMap((turn) => turn.nodes);
    expect(nodes.filter((node) => node.type === 'assistant_text' && node.metadata?.agentError)).toHaveLength(1);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
  }
});

it('keeps one real failure card and one DOM node through 60 seconds of rerenders and child completion', async () => {
  vi.useFakeTimers();
  useAppStore.setState({ disclosureLevel: 'advanced' });
  let terminal = false;
  runtime.invokeDomain.mockImplementation(async () => ({ sessionId, nodes: [
    { background: true, status: terminal ? 'completed' : 'running' },
  ] }));
  const view = render(<TurnBasedTraceView projection={projectTurns(messages, sessionId, false)} />);
  for (let poll = 0; poll <= 12; poll++) {
    if (poll) await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    // The real page reprojects as snapshots/tree observations arrive.
    view.rerender(<TurnBasedTraceView projection={projectTurns(messages, sessionId, false)} />);
    expect(view.queryAllByRole('alert')).toHaveLength(1);
    const failureId = view.getByRole('alert').closest('[data-trace-node-id]')!.getAttribute('data-trace-node-id');
    expect(view.container.querySelectorAll(`[data-trace-node-id="${failureId}"]`)).toHaveLength(1);
  }
  terminal = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(view.queryAllByRole('alert')).toHaveLength(1);
  expect(view.queryAllByTestId('background-children-notice')).toHaveLength(0);
});
