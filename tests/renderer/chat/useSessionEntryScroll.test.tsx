// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { revealTurnEnd, useContentHiddenBelow, useSessionEntryScroll } from '../../../src/renderer/components/features/chat/useSessionEntryScroll';

const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ turnId: `t${i}` })) as unknown as TraceTurn[];

function setup(sessionId: string, list: TraceTurn[], overrides: { streaming?: boolean } = {}) {
  const scroller = document.createElement('div');
  Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 1000, configurable: true });
  const projectionTurnsRef = { current: list };
  const props = {
    sessionId,
    turns: list,
    projectionTurnsRef,
    virtuosoRef: { current: { scrollToIndex: vi.fn() } as never },
    scrollerElementRef: { current: scroller },
    outputFollowStreamingRef: { current: Boolean(overrides.streaming) },
    keepActiveOutputVisibleRef: { current: true },
    activeDisplayScrollCancelRef: { current: null as (() => void) | null },
    sessionEntrySettlingRef: { current: false },
    userScrollLastInteractionAtRef: { current: 0 },
    setIsAtBottom: vi.fn(),
  };
  return props;
}

describe('useSessionEntryScroll · 入场隐藏', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('有 turns 的会话在入场结算收敛前隐藏列表，收敛后揭示', async () => {
    const props = setup('s1', turns(45));
    const { result } = renderHook(() => useSessionEntryScroll(props));
    expect(result.current.entryHidden).toBe(true);

    act(() => { result.current.noteRange(); });
    // 首个 range 回报后仍在结算中：不能让用户看到预估高度下的中段
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(result.current.entryHidden).toBe(true);

    // 结算 60 帧上限 / 16 帧稳定后揭示
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.entryHidden).toBe(false);
  });

  it('用户在结算期滚动取消结算时也会揭示（不会永久空白）', async () => {
    const props = setup('s1', turns(45));
    const { result } = renderHook(() => useSessionEntryScroll(props));
    act(() => { result.current.noteRange(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(result.current.entryHidden).toBe(true);
    props.userScrollLastInteractionAtRef.current = 123;
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(result.current.entryHidden).toBe(false);
  });

  it('流式中进入的会话不走结算，range 回报即揭示', () => {
    const props = setup('s1', turns(3), { streaming: true });
    const { result } = renderHook(() => useSessionEntryScroll(props));
    expect(result.current.entryHidden).toBe(true);
    act(() => { result.current.noteRange(); });
    expect(result.current.entryHidden).toBe(false);
  });

  it('range 一直不回报时兜底定时器揭示', async () => {
    const props = setup('s1', turns(45));
    const { result } = renderHook(() => useSessionEntryScroll(props));
    expect(result.current.entryHidden).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(result.current.entryHidden).toBe(false);
  });

  it('空会话不隐藏；切换到新会话重新隐藏', () => {
    const props = setup('s1', []);
    const { result, rerender } = renderHook((p) => useSessionEntryScroll(p), { initialProps: props });
    expect(result.current.entryHidden).toBe(false);
    rerender({ ...props, sessionId: 's2', turns: turns(10), projectionTurnsRef: { current: turns(10) } });
    expect(result.current.entryHidden).toBe(true);
  });

  it('pending 期间用户滚轮取消入场（main #3091 路径）时也揭示', async () => {
    const props = setup('s1', turns(45));
    document.body.appendChild(props.scrollerElementRef.current);
    const { result } = renderHook(() => useSessionEntryScroll(props));
    expect(result.current.entryHidden).toBe(true);
    await act(async () => { props.scrollerElementRef.current.dispatchEvent(new Event('wheel')); });
    expect(result.current.entryHidden).toBe(false);
  });
});

describe('revealTurnEnd', () => {
  it('末轮落到真实底部（含 Footer），非末轮仍按 turn 末尾对齐', () => {
    const scrollToIndex = vi.fn();
    const scroller = { scrollTop: 100, scrollHeight: 2400 };
    revealTurnEnd({ scrollToIndex }, scroller, 4, 5);
    expect(scroller.scrollTop).toBe(2400);
    expect(scrollToIndex).not.toHaveBeenCalled();

    revealTurnEnd({ scrollToIndex }, scroller, 2, 5);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 2, align: 'end', behavior: 'auto' });
  });
});

describe('useContentHiddenBelow', () => {
  function geometry(scroller: HTMLElement, gap: number) {
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
    scroller.scrollTop = 2000 - 600 - gap;
  }

  it('阈值内也要报「下面还有」：离底 60px（卡底和按钮被裁）出箭头，Footer 呼吸带内不出，暂停时不判', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const flush = () => act(() => { while (frames.length) frames.shift()!(0); });
    const scroller = document.createElement('div');
    const paused = { current: false };

    geometry(scroller, 60);
    const { result, rerender } = renderHook(({ key }) => useContentHiddenBelow(scroller, paused, key), { initialProps: { key: 'a' } });
    flush();
    expect(result.current).toBe(true);

    geometry(scroller, 20);
    act(() => { scroller.dispatchEvent(new Event('scroll')); });
    flush();
    expect(result.current).toBe(false);

    paused.current = true;
    geometry(scroller, 300);
    rerender({ key: 'b' });
    flush();
    expect(result.current).toBe(false);
    vi.unstubAllGlobals();
  });
});
