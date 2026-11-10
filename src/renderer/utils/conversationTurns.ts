import type { TraceProjection, TraceTurn } from '@shared/contract/trace';

/** History entries such as confirmation receipts never own run state or output. */
export function getLastConversationTurnIndex(turns: readonly TraceTurn[]): number {
  return turns.findLastIndex((turn) => !turn.standalone);
}

export function getActiveConversationTurnIndex(projection: TraceProjection): number {
  const index = projection.activeTurnIndex;
  return index >= 0 && projection.turns[index] && !projection.turns[index].standalone ? index : -1;
}
