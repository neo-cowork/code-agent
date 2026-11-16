import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import type { TraceTurn } from '@shared/contract/trace';

export function scheduleAfterLayout(callback: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(callback, 0);
  });

  return () => {
    cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
  };
}

export function isScrollerNearBottom(
  scroller: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold = 96,
): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= threshold;
}

/**
 * 把跟随中的 turn 末尾露出来。它是列表最后一项时直接落到真实底部（含 Footer 呼吸间距）：
 * scrollToIndex(align:'end') 按 Virtuoso 自己量的项高对齐，末张卡的外边距和 Footer 落在视口外，
 * 停车后的授权卡按钮露半截又不到「回到底部」的阈值（N-FIX-CHAT-BOTTOM-CARD-HIDDEN-UNDER-COMPOSER）。
 */
export function revealTurnEnd(
  virtuoso: Pick<VirtuosoHandle, 'scrollToIndex'> | null,
  scroller: Pick<HTMLElement, 'scrollTop' | 'scrollHeight'> | null,
  turnIndex: number,
  turnCount: number,
): void {
  if (scroller && turnIndex === turnCount - 1) {
    scroller.scrollTop = scroller.scrollHeight;
    return;
  }
  virtuoso?.scrollToIndex({ index: turnIndex, align: 'end', behavior: 'auto' });
}

// 末尾内容超出 Footer 呼吸带（h-6）再多 8px 被挡在可视区下方，就算「下面还有」。
const HIDDEN_BELOW_TOLERANCE_PX = 32;

/**
 * 末尾内容是否真被挡在可视区下方。Virtuoso 的 96px「在底部」阈值会把几十像素的差距藏起来：
 * 卡底和按钮被裁，却不出「回到底部」，用户不知道下面还有东西（真机第二轮）。
 */
export function isContentHiddenBelow(
  scroller: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > HIDDEN_BELOW_TOLERANCE_PX;
}

/** 滚动或列表/视口尺寸变化后（每帧至多一次）回调，供「回到底部」按真实几何重算。 */
export function useScrollGeometryChange(scroller: HTMLElement | null, onChange: () => void): void {
  useEffect(() => {
    if (!scroller) return;
    let frame: number | null = null;
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(() => { frame = null; onChange(); });
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(scroller);
    const itemList = scroller.querySelector('[data-testid="virtuoso-item-list"]');
    if (itemList) observer?.observe(itemList);
    scroller.addEventListener('scroll', schedule, { passive: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      scroller.removeEventListener('scroll', schedule);
    };
  }, [onChange, scroller]);
}

// 用户在列表里按过指针（展开/折叠、拖滚动条）后这段时间内，列表变高变矮都不追底，免得点开的内容被顶走。
const LIST_GROWTH_AFTER_POINTER_PAUSE_MS = 1000;

interface ListResizeFollowOptions {
  scroller: HTMLElement | null;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  projectionTurnsRef: RefObject<TraceTurn[]>;
  keepActiveOutputVisibleRef: RefObject<boolean>;
  outputFollowStreamingRef: RefObject<boolean>;
  sessionEntrySettlingRef: RefObject<boolean>;
  historyPrependInProgressRef: RefObject<boolean>;
  isUserScrollSuppressed: () => boolean;
}

/**
 * 非流式贴底跟随时，列表里任何一轮晚到的高度变化（会话首开后授权卡按钮、content-visibility
 * 落定的真实排版、图片/代码块）都要重新落底：只盯跟随轮会让会话首开停在中间，列表变矮时
 * Virtuoso 的补偿也可能把视口留在离底一两百像素处。流式期间不参与（仍只盯活动轮，防抖动）；
 * 用户按着/刚松开指针（展开折叠、拖滚动条）或本来就离底很远时不动。
 * 不经跟随轮登记（会话首开时它为空，补登记要多一次 React commit，perf-journey 棘轮不收）。
 */
export function useListResizeFollow({
  scroller, virtuosoRef, projectionTurnsRef, keepActiveOutputVisibleRef,
  outputFollowStreamingRef, sessionEntrySettlingRef, historyPrependInProgressRef, isUserScrollSuppressed,
}: ListResizeFollowOptions): void {
  useEffect(() => {
    const itemList = scroller?.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]');
    if (!scroller || !itemList || typeof ResizeObserver !== 'function') return;
    let lastHeight = itemList.getBoundingClientRect().height;
    let pointerDown = false;
    let pointerUpAt = 0;
    let cancelReveal: (() => void) | null = null;
    const onPointerDown = () => { pointerDown = true; };
    const onPointerUp = () => { pointerDown = false; pointerUpAt = Date.now(); };
    const observer = new ResizeObserver(() => {
      const height = itemList.getBoundingClientRect().height;
      const delta = Math.abs(height - lastHeight);
      lastHeight = height;
      if (delta === 0 || outputFollowStreamingRef.current) return;
      if (!keepActiveOutputVisibleRef.current || isUserScrollSuppressed()) return;
      if (!isScrollerNearBottom(scroller, 96 + delta)) return;
      if (cancelReveal) return;
      // 等 Virtuoso 这一轮测量补偿做完再落底，否则补偿会把视口又挪走。
      cancelReveal = scheduleAfterLayout(() => {
        cancelReveal = null;
        if (pointerDown || Date.now() - pointerUpAt < LIST_GROWTH_AFTER_POINTER_PAUSE_MS) return;
        if (!keepActiveOutputVisibleRef.current || isUserScrollSuppressed()) return;
        // 入场结算/历史前插期间由它们自己定位，这里不插手。
        if (sessionEntrySettlingRef.current || historyPrependInProgressRef.current) return;
        const turns = projectionTurnsRef.current;
        revealTurnEnd(virtuosoRef.current, scroller, turns.length - 1, turns.length);
      });
    });
    observer.observe(itemList);
    scroller.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    return () => {
      cancelReveal?.();
      observer.disconnect();
      scroller.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerUp, true);
    };
  }, [historyPrependInProgressRef, isUserScrollSuppressed, keepActiveOutputVisibleRef, outputFollowStreamingRef,
    projectionTurnsRef, scroller, sessionEntrySettlingRef, virtuosoRef]);
}

// scroller 还没量出尺寸时无从判断，返回 null 表示保持现状，不要硬猜。
function computeScrollerAtBottom(
  scroller: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'> | null,
): boolean | null {
  if (!scroller || scroller.scrollHeight <= 0) return null;
  return scroller.scrollHeight <= scroller.clientHeight || isScrollerNearBottom(scroller);
}

const SETTLE_STABLE_FRAMES = 16;
/** 兜底：入场结算任何路径都没走到揭示时，最迟这么久后强制显示列表，避免空白。 */
const ENTRY_REVEAL_FAILSAFE_MS = 2000;

interface BottomSettlementOptions {
  turnsAtJump: TraceTurn[];
  projectionTurnsRef: RefObject<TraceTurn[]>;
  scrollerElementRef: RefObject<HTMLElement | null>;
  keepActiveOutputVisibleRef: RefObject<boolean>;
  activeDisplayScrollCancelRef: RefObject<(() => void) | null>;
  shouldContinue?: () => boolean;
  onSettled?: () => void;
  onCancel?: () => void;
}

/**
 * 落底结算只在「轮」真的变了（新增/减少一轮、末轮换了）时让位。冷启动水合会把同样内容的
 * 投影重建好几次（新数组引用），按引用比会把结算半路掐断，会话首开停在离底几十到一两百像素
 * 处（N-FIX-CHAT-BOTTOM-CARD-HIDDEN-UNDER-COMPOSER 真机第二轮）。
 */
function isSameTurnList(current: readonly TraceTurn[], atJump: readonly TraceTurn[]): boolean {
  return current === atJump
    || (current.length === atJump.length && current.at(-1)?.turnId === atJump.at(-1)?.turnId);
}

export function startBottomSettlement({
  turnsAtJump,
  projectionTurnsRef,
  scrollerElementRef,
  keepActiveOutputVisibleRef,
  activeDisplayScrollCancelRef,
  shouldContinue = () => true,
  onSettled = () => undefined,
  onCancel = () => undefined,
}: BottomSettlementOptions): void {
  let remainingFrames = 60;
  let stableFrames = 0;
  let lastScrollHeight = -1;
  let settled = false;
  let frame: number | ReturnType<typeof setTimeout> | null = null;
  const cancelSettlement = () => {
    if (frame !== null) {
      if (typeof cancelAnimationFrame === 'function' && typeof frame === 'number') {
        cancelAnimationFrame(frame);
      } else {
        clearTimeout(frame);
      }
    }
    frame = null;
    if (activeDisplayScrollCancelRef.current === cancelSettlement) {
      activeDisplayScrollCancelRef.current = null;
    }
    if (!settled) onCancel();
  };
  const settleBottom = () => {
    frame = null;
    if (
      !isSameTurnList(projectionTurnsRef.current, turnsAtJump)
      || !keepActiveOutputVisibleRef.current
      || !shouldContinue()
    ) {
      cancelSettlement();
      return;
    }
    const scroller = scrollerElementRef.current;
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      const atBottom = scroller.scrollHeight === lastScrollHeight
        && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1;
      stableFrames = atBottom ? stableFrames + 1 : 0;
      lastScrollHeight = scroller.scrollHeight;
    }
    remainingFrames -= 1;
    if (remainingFrames <= 0 || stableFrames >= SETTLE_STABLE_FRAMES) {
      settled = true;
      onSettled();
      cancelSettlement();
      return;
    }
    frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(settleBottom)
      : setTimeout(settleBottom, 16);
  };
  activeDisplayScrollCancelRef.current = cancelSettlement;
  frame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(settleBottom)
    : setTimeout(settleBottom, 16);
}

interface SessionEntryScrollState {
  sessionId: string;
  hasTurns: boolean;
  pending: boolean;
  resetBottom: boolean;
  interactionAt: number;
}

export interface SessionEntryScroll {
  noteRange: () => void;
  /** 入场结算收敛前为 true，调用方据此隐藏列表。 */
  entryHidden: boolean;
}

interface SessionEntryScrollOptions {
  sessionId: string;
  turns: TraceTurn[];
  projectionTurnsRef: RefObject<TraceTurn[]>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerElementRef: RefObject<HTMLElement | null>;
  outputFollowStreamingRef: RefObject<boolean>;
  keepActiveOutputVisibleRef: RefObject<boolean>;
  activeDisplayScrollCancelRef: RefObject<(() => void) | null>;
  sessionEntrySettlingRef: RefObject<boolean>;
  userScrollLastInteractionAtRef: RefObject<number>;
  setIsAtBottom: Dispatch<SetStateAction<boolean>>;
}

export function useSessionEntryScroll({
  sessionId,
  turns,
  projectionTurnsRef,
  virtuosoRef,
  scrollerElementRef,
  outputFollowStreamingRef,
  keepActiveOutputVisibleRef,
  activeDisplayScrollCancelRef,
  sessionEntrySettlingRef,
  userScrollLastInteractionAtRef,
  setIsAtBottom,
}: SessionEntryScrollOptions): SessionEntryScroll {
  // 长会话首帧由 Virtuoso 按预估高度（defaultItemHeight）定位，真实行高测出后才收敛到底部，
  // 期间用户会看到中段内容再滑到底。入场结算收敛前把列表隐藏（仍参与布局与测量），收敛/取消后揭示。
  const [revealedSessionId, setRevealedSessionId] = useState<string | null>(null);
  const entryHidden = turns.length > 0 && revealedSessionId !== sessionId;
  const reveal = useCallback(() => setRevealedSessionId(sessionId), [sessionId]);
  useEffect(() => {
    if (!entryHidden) return;
    const timer = setTimeout(reveal, ENTRY_REVEAL_FAILSAFE_MS);
    return () => clearTimeout(timer);
  }, [entryHidden, reveal]);

  const entryRef = useRef<SessionEntryScrollState>({
    sessionId,
    hasTurns: turns.length > 0,
    pending: turns.length > 0,
    resetBottom: false,
    interactionAt: userScrollLastInteractionAtRef.current,
  });
  const entry = entryRef.current;
  if (entry.sessionId !== sessionId) {
    entryRef.current = {
      sessionId,
      hasTurns: turns.length > 0,
      pending: turns.length > 0,
      resetBottom: false,
      interactionAt: userScrollLastInteractionAtRef.current,
    };
  } else if (!entry.hasTurns && turns.length > 0) {
    entry.hasTurns = true;
    entry.pending = true;
    entry.resetBottom = true;
  }
  const currentEntry = entryRef.current;
  if (turns.length === 0) {
    currentEntry.pending = false;
    currentEntry.resetBottom = false;
    sessionEntrySettlingRef.current = false;
  } else if (currentEntry.pending) {
    sessionEntrySettlingRef.current = true;
  }

  // 入场 pending 期间 sessionEntrySettlingRef 屏蔽了 Virtuoso 的 atBottomStateChange，
  // 而它只在状态变化时发出——被吞掉的 false 不会重发。凡 pending/结算结束却没落到底部
  // 的路径都必须按 scroller 实况重算一次，否则 isAtBottom 卡在过期的 true，按钮消失。
  const setIsAtBottomFromScroller = useCallback(() => {
    const atBottom = computeScrollerAtBottom(scrollerElementRef.current);
    if (atBottom !== null) setIsAtBottom(atBottom);
  }, [scrollerElementRef, setIsAtBottom]);

  const scrollerElement = scrollerElementRef.current;
  useEffect(() => {
    if (!currentEntry.pending || !scrollerElement) return;
    const cancelPending = () => {
      // pending 结束后监听器可能仍挂着（deps 不含 pending），这里挡掉，避免干扰结算期状态。
      if (!currentEntry.pending) return;
      currentEntry.pending = false;
      currentEntry.resetBottom = false;
      sessionEntrySettlingRef.current = false;
      setIsAtBottomFromScroller();
      reveal();
    };
    scrollerElement.addEventListener('wheel', cancelPending, { passive: true });
    scrollerElement.addEventListener('touchmove', cancelPending, { passive: true });
    scrollerElement.addEventListener('keydown', cancelPending);
    return () => {
      scrollerElement.removeEventListener('wheel', cancelPending);
      scrollerElement.removeEventListener('touchmove', cancelPending);
      scrollerElement.removeEventListener('keydown', cancelPending);
    };
  }, [currentEntry, reveal, scrollerElement, sessionEntrySettlingRef, setIsAtBottomFromScroller, turns.length]);

  const previousSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    previousSessionIdRef.current = sessionId;
    setIsAtBottom(true);
  }, [sessionId, setIsAtBottom]);

  const noteRange = useCallback(() => {
    const entry = entryRef.current;
    if (!entry.pending || entry.sessionId !== sessionId) return;
    entry.pending = false;
    sessionEntrySettlingRef.current = false;
    // 先按 scroller 实况重算：下面的早退路径（流式跟随、用户已滚动、投影还没建好）
    // 不再强置 true，用户在 pending 期间的滚动不会被过期 isAtBottom 吞掉。
    setIsAtBottomFromScroller();
    if (projectionTurnsRef.current.length === 0) {
      reveal();
      return;
    }
    entry.resetBottom = false;
    if (outputFollowStreamingRef.current || userScrollLastInteractionAtRef.current !== entry.interactionAt) {
      reveal();
      return;
    }
    const lastIndex = projectionTurnsRef.current.length - 1;
    if (lastIndex < 0) {
      reveal();
      return;
    }
    sessionEntrySettlingRef.current = true;
    // 结算期间 atBottomStateChange 被屏蔽；入场前 Virtuoso 可能已报过“不在底部”，
    // 这里先置位，避免估算高度阶段闪出“回到底部”按钮。用户滚动取消时由 onCancel 重算。
    setIsAtBottom(true);

    scheduleAfterLayout(() => {
      // 会话已切换：settling 归新会话的渲染入口管，过期的帧不许碰它。
      if (entryRef.current !== entry) return;
      if (outputFollowStreamingRef.current || userScrollLastInteractionAtRef.current !== entry.interactionAt) {
        sessionEntrySettlingRef.current = false;
        setIsAtBottomFromScroller();
        reveal();
        return;
      }
      keepActiveOutputVisibleRef.current = true;
      virtuosoRef.current?.scrollToIndex({ index: lastIndex, align: 'end', behavior: 'auto' });
      activeDisplayScrollCancelRef.current?.();
      startBottomSettlement({
        turnsAtJump: projectionTurnsRef.current,
        projectionTurnsRef,
        scrollerElementRef,
        keepActiveOutputVisibleRef,
        activeDisplayScrollCancelRef,
        shouldContinue: () => (
          entryRef.current === entry
          && !outputFollowStreamingRef.current
          && userScrollLastInteractionAtRef.current === entry.interactionAt
        ),
        onSettled: () => {
          sessionEntrySettlingRef.current = false;
          setIsAtBottom(true);
          reveal();
        },
        onCancel: () => {
          sessionEntrySettlingRef.current = false;
          setIsAtBottomFromScroller();
          reveal();
        },
      });
    });
  }, [reveal, projectionTurnsRef, sessionId, setIsAtBottom, setIsAtBottomFromScroller, userScrollLastInteractionAtRef, outputFollowStreamingRef, keepActiveOutputVisibleRef, virtuosoRef, scrollerElementRef, activeDisplayScrollCancelRef, sessionEntrySettlingRef]);
  return { noteRange, entryHidden };
}
