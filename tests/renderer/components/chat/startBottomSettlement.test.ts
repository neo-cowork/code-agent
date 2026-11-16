import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../../src/shared/contract/trace';
import { startBottomSettlement } from '../../../../src/renderer/components/features/chat/useSessionEntryScroll';

describe('startBottomSettlement', () => {
  let queue: Array<() => void>;
  beforeEach(() => {
    queue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => queue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  // Browser-like scroller: scrollTop writes clamp to scrollHeight - clientHeight.
  function makeScroller(heightAt: (frame: number) => number) {
    let frame = 0;
    let top = 0;
    const scroller = {
      clientHeight: 500,
      get scrollHeight() { return heightAt(frame); },
      get scrollTop() { return top; },
      set scrollTop(v: number) { top = Math.min(v, this.scrollHeight - this.clientHeight); },
    };
    return { scroller, tick: () => { frame += 1; } };
  }

  function run(heightAt: (frame: number) => number) {
    const turns: TraceTurn[] = [];
    const { scroller, tick } = makeScroller(heightAt);
    const onSettled = vi.fn();
    const onCancel = vi.fn();
    startBottomSettlement({
      turnsAtJump: turns,
      projectionTurnsRef: { current: turns },
      scrollerElementRef: { current: scroller as unknown as HTMLElement },
      keepActiveOutputVisibleRef: { current: true },
      activeDisplayScrollCancelRef: { current: null },
      onSettled,
      onCancel,
    });
    let frames = 0;
    while (queue.length > 0) {
      const cb = queue.shift()!;
      frames += 1;
      cb();
      tick();
    }
    return { frames, onSettled, onCancel, scroller };
  }

  it('stops early once scrollHeight is stable and the scroller is at the bottom', () => {
    const { frames, onSettled, onCancel } = run(() => 3000);
    expect(frames).toBeLessThan(60);
    expect(frames).toBe(17);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('keeps settling when scrollHeight grows after the first stable window', () => {
    const { frames, onSettled, scroller } = run((frame) => frame < 9 ? 3000 : 3400);
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

    expect(frames).toBeGreaterThan(9);
    expect(frames).toBeLessThan(60);
    expect(distanceFromBottom).toBe(0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('keeps going while scrollHeight still grows, up to the 60-frame cap', () => {
    const { frames, onSettled } = run((frame) => 3000 + frame * 40);
    expect(frames).toBe(60);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  // 冷启动水合把同样内容的投影重建成新数组：结算不能半路让位（真机第二轮首开停在中间）。
  function runWithRebuild(rebuild: (turns: TraceTurn[]) => TraceTurn[]) {
    const turn = { turnNumber: 1, turnId: 't1', status: 'completed', startTime: 1, nodes: [] } as TraceTurn;
    const turns: TraceTurn[] = [turn];
    const projectionTurnsRef = { current: turns };
    const { scroller, tick } = makeScroller(() => 3000);
    const onSettled = vi.fn();
    const onCancel = vi.fn();
    startBottomSettlement({
      turnsAtJump: turns,
      projectionTurnsRef,
      scrollerElementRef: { current: scroller as unknown as HTMLElement },
      keepActiveOutputVisibleRef: { current: true },
      activeDisplayScrollCancelRef: { current: null },
      onSettled,
      onCancel,
    });
    let frames = 0;
    while (queue.length > 0) {
      const cb = queue.shift()!;
      frames += 1;
      if (frames === 3) projectionTurnsRef.current = rebuild(turns);
      cb();
      tick();
    }
    return { onSettled, onCancel };
  }

  it('same-content projection rebuilds (new array, same turns) do not cancel the settlement', () => {
    const { onSettled, onCancel } = runWithRebuild((turns) => turns.map((turn) => ({ ...turn })));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('a genuinely new turn still cancels the settlement', () => {
    const { onSettled, onCancel } = runWithRebuild((turns) => [
      ...turns,
      { turnNumber: 2, turnId: 't2', status: 'streaming', startTime: 2, nodes: [] } as TraceTurn,
    ]);
    expect(onSettled).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
