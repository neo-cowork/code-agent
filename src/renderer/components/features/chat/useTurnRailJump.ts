import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import type { TraceTurn } from '@shared/contract/trace';

interface TurnRailJumpOptions {
  sessionId: string;
  turnsRef: RefObject<TraceTurn[]>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  followRef: RefObject<boolean>;
  cancelRef: RefObject<(() => void) | null>;
  nodeSelector: (nodeId: string, nodeType: string) => string;
}

/** Share the rail's turn navigation and settle an added message after virtual mounting. */
export function useTurnRailJump({ sessionId, turnsRef, virtuosoRef, scrollerRef, followRef, cancelRef, nodeSelector }: TurnRailJumpOptions) {
  const [expanded, setExpanded] = useState<{ sessionId: string; turnId: string } | null>(null);
  useEffect(() => () => { cancelRef.current?.(); }, [cancelRef, sessionId]);

  const jump = useCallback((turnId: string, nodeId?: string) => {
    const index = turnsRef.current.findIndex((turn) => turn.turnId === turnId);
    if (index < 0) return;
    followRef.current = false;
    cancelRef.current?.();
    cancelRef.current = null;
    setExpanded(nodeId ? { sessionId, turnId } : null);
    virtuosoRef.current?.scrollToIndex({ index, align: 'start', behavior: 'auto' });
    if (!nodeId) return;

    let frame = 0;
    let remaining = 30;
    let alignedFrames = 0;
    const cancel = () => {
      cancelAnimationFrame(frame);
      if (cancelRef.current === cancel) cancelRef.current = null;
    };
    const settle = () => {
      followRef.current = false;
      const scroller = scrollerRef.current;
      const node = scroller?.querySelector<HTMLElement>(nodeSelector(nodeId, 'user'));
      if (node && scroller) {
        const atTop = Math.abs(node.getBoundingClientRect().top - scroller.getBoundingClientRect().top) < 2;
        alignedFrames = atTop ? alignedFrames + 1 : 0;
        node.scrollIntoView({ block: 'start', behavior: 'auto' });
      } else {
        virtuosoRef.current?.scrollToIndex({ index, align: 'start', behavior: 'auto' });
      }
      remaining -= 1;
      if (remaining <= 0 || alignedFrames >= 3) { cancel(); return; }
      frame = requestAnimationFrame(settle);
    };
    cancelRef.current = cancel;
    frame = requestAnimationFrame(settle);
  }, [cancelRef, followRef, nodeSelector, scrollerRef, sessionId, turnsRef, virtuosoRef]);

  const handleRailJump = useCallback((turnId: string) => jump(turnId), [jump]);
  const handleRailNodeJump = useCallback((turnId: string, nodeId: string) => jump(turnId, nodeId), [jump]);
  return { handleRailJump, handleRailNodeJump, expandedTurnId: expanded?.sessionId === sessionId ? expanded.turnId : null };
}
