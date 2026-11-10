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
      projectionTurnsRef.current !== turnsAtJump
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
    entry.interactionAt = userScrollLastInteractionAtRef.current;
  }

  const previousSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    previousSessionIdRef.current = sessionId;
    setIsAtBottom(true);
  }, [sessionId, setIsAtBottom]);

  const noteRange = useCallback(() => {
    const entry = entryRef.current;
    if (!entry.pending || entry.sessionId !== sessionId || projectionTurnsRef.current.length === 0) return;
    entry.pending = false;
    if (entry.resetBottom) {
      entry.resetBottom = false;
      setIsAtBottom(true);
    }
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
      if (
        entryRef.current !== entry
        || outputFollowStreamingRef.current
        || userScrollLastInteractionAtRef.current !== entry.interactionAt
      ) {
        sessionEntrySettlingRef.current = false;
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
          reveal();
          const scroller = scrollerElementRef.current;
          if (scroller && scroller.scrollHeight > 0) {
            setIsAtBottom(scroller.scrollHeight <= scroller.clientHeight || isScrollerNearBottom(scroller));
          }
        },
      });
    });
  }, [reveal, projectionTurnsRef, sessionId, setIsAtBottom, userScrollLastInteractionAtRef, outputFollowStreamingRef, keepActiveOutputVisibleRef, virtuosoRef, scrollerElementRef, activeDisplayScrollCancelRef, sessionEntrySettlingRef]);
  return { noteRange, entryHidden };
}
