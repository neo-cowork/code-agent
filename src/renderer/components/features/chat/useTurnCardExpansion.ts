import { useCallback, useLayoutEffect, useRef, useState } from 'react';

interface TurnCardExpansionOptions {
  canFold: boolean;
  hasExternalStatusLine: boolean;
  keepLastTurnOpen: boolean;
  defaultExpanded?: boolean;
  isSessionProcessing?: boolean;
  forceExpanded?: boolean;
  expandRequest?: { nodeId: string };
}

/** Navigation opens once; search can force open, and normal folding remains user controlled. */
export function useTurnCardExpansion({
  canFold, hasExternalStatusLine, keepLastTurnOpen, defaultExpanded,
  isSessionProcessing, forceExpanded, expandRequest,
}: TurnCardExpansionOptions) {
  // A processing session can be between runs; keep its current work visible until idle.
  const [userExpanded, setUserExpanded] = useState(
    hasExternalStatusLine
      ? false
      : Boolean(defaultExpanded) || !canFold || Boolean(isSessionProcessing),
  );
  const expanded = userExpanded || Boolean(forceExpanded);
  const userToggledRef = useRef(false);

  // A fresh request (including the same message clicked again) is an explicit user action.
  useLayoutEffect(() => {
    if (!expandRequest) return;
    userToggledRef.current = true;
    setUserExpanded(true);
  }, [expandRequest]);

  // Simple detail folds at idle completion unless the user already chose an expansion state.
  const autoFoldEligible = canFold && !keepLastTurnOpen && !isSessionProcessing;
  const autoFoldEligibleRef = useRef(autoFoldEligible);
  useLayoutEffect(() => {
    const wasEligible = autoFoldEligibleRef.current;
    autoFoldEligibleRef.current = autoFoldEligible;
    if (!wasEligible && autoFoldEligible && !userToggledRef.current) {
      setUserExpanded(false);
    }
  }, [autoFoldEligible]);

  const handleToggleExpanded = useCallback(() => {
    userToggledRef.current = true;
    setUserExpanded(!expanded);
  }, [expanded]);
  return { expanded, folded: canFold && !expanded, handleToggleExpanded };
}
