// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TraceProjection, TraceTurn } from '../../../src/shared/contract/trace';
import { TurnBasedTraceView } from '../../../src/renderer/components/features/chat/TurnBasedTraceView';
import { useAppStore } from '../../../src/renderer/stores/appStore';

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return {
    Virtuoso: ReactModule.forwardRef(function List(props: {
      scrollerRef: (element: HTMLDivElement | null) => void;
      data: TraceTurn[];
      firstItemIndex: number;
      itemContent: (index: number, turn: TraceTurn) => React.ReactNode;
    }, ref) {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn(), autoscrollToBottom: vi.fn() }));
      return <div ref={props.scrollerRef}>{props.data.map((turn, index) => (
        <ReactModule.Fragment key={turn.turnId}>{props.itemContent(props.firstItemIndex + index, turn)}</ReactModule.Fragment>
      ))}</div>;
    }),
  };
});

const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  useAppStore.setState({ disclosureLevel: 'standard', language: 'zh' });
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

it('lets the user collapse after an added-message jump settles, then reopen the same message', () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  useAppStore.setState({ disclosureLevel: 'standard', language: 'en' });
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const settle = () => {
    for (let index = 0; index < 35; index += 1) act(() => {
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0));
    });
  };
  const turns: TraceTurn[] = Array.from({ length: 8 }, (_, index) => ({
    turnId: `turn-${index + 1}`, turnNumber: index + 1, status: 'completed', startTime: 1_000, endTime: 10_000,
    nodes: [
      { id: `prompt-${index}`, type: 'user', content: `Summarize meeting ${index + 1}`, timestamp: 1_000 },
      ...(index === 0 ? [
        { id: 'middle-1', type: 'assistant_text' as const, content: 'The notes cover three dates.', timestamp: 2_000 },
        { id: 'added-user', type: 'user' as const, content: 'Put the dates in a table.', timestamp: 3_000 },
        { id: 'middle-2', type: 'assistant_text' as const, content: 'Preparing the table.', timestamp: 4_000 },
      ] : []),
      { id: `reply-${index}`, type: 'assistant_text', content: `Meeting ${index + 1} summary is ready.`, timestamp: 9_000 },
    ],
  }));
  const projection: TraceProjection = { sessionId: 'rail-collapse-session', turns, activeTurnIndex: -1 };
  const view = render(<TurnBasedTraceView projection={projection} />);
  settle();
  const toggle = () => screen.getByRole('button', { name: /^Worked for/ });
  const addedNode = () => view.container.querySelector('[data-trace-node-id="added-user"][data-trace-node-type="user"]');
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(addedNode()).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Expand list' }));
  const jump = () => fireEvent.click(screen.getByRole('button', { name: 'Added · Put the dates in a table.' }));
  jump(); settle();
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(addedNode()).not.toBeNull();
  fireEvent.click(toggle());
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(addedNode()).toBeNull();
  view.rerender(<TurnBasedTraceView projection={projection} />);
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  jump(); settle();
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(addedNode()).not.toBeNull();
  fireEvent.click(toggle());
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
});
