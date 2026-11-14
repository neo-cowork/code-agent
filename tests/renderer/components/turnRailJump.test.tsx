// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { useTurnRailJump } from '../../../src/renderer/components/features/chat/useTurnRailJump';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('expands the target, retries virtual mounting, aligns the exact user node and cancels on session change', () => {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++nextFrame, cb); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const tick = () => { const callbacks = [...frames.values()]; frames.clear(); act(() => callbacks.forEach(cb => cb(0))); };
  const scrollToIndex = vi.fn();
  const previousCancel = vi.fn();
  const scroller = document.createElement('div'); document.body.append(scroller);
  const args = {
    sessionId: 'session-1',
    turnsRef: { current: [{ turnId: 'turn-1' }, { turnId: 'turn-2' }] as TraceTurn[] },
    virtuosoRef: { current: { scrollToIndex } as unknown as import('react-virtuoso').VirtuosoHandle },
    scrollerRef: { current: scroller }, followRef: { current: true }, cancelRef: { current: previousCancel as (() => void) | null },
    nodeSelector: (id: string, type: string) => `[data-trace-node-id="${id}"][data-trace-node-type="${type}"]`,
  };
  const { result, rerender } = renderHook(({ sessionId }) => useTurnRailJump({ ...args, sessionId }), { initialProps: { sessionId: 'session-1' } });
  act(() => result.current.handleRailNodeJump('turn-1', 'added-2'));
  expect(result.current.expansionRequest).toEqual({ sessionId: 'session-1', turnId: 'turn-1', nodeId: 'added-2' });
  expect(args.followRef.current).toBe(false);
  expect(previousCancel).toHaveBeenCalledOnce();
  expect(scrollToIndex).toHaveBeenCalledWith({ index: 0, align: 'start', behavior: 'auto' });
  tick(); expect(scrollToIndex).toHaveBeenCalledTimes(2);
  const other = document.createElement('div'); other.dataset.traceNodeId = 'added-2'; other.dataset.traceNodeType = 'assistant_text';
  other.scrollIntoView = vi.fn(); scroller.append(other);
  const node = document.createElement('div'); node.dataset.traceNodeId = 'added-2'; node.dataset.traceNodeType = 'user';
  node.scrollIntoView = vi.fn(); scroller.append(node);
  tick(); expect(node.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
  expect(other.scrollIntoView).not.toHaveBeenCalled();
  rerender({ sessionId: 'session-2' });
  expect(result.current.expansionRequest).toBeUndefined(); expect(frames.size).toBe(0);
  act(() => result.current.handleRailJump('turn-2'));
  expect(result.current.expansionRequest).toBeUndefined();
  expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 1, align: 'start', behavior: 'auto' });
});
