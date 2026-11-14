import type { TraceProjection, TraceTurn } from '@shared/contract/trace';

/** History entries such as confirmation receipts never own run state or output. */
export function getLastConversationTurnIndex(turns: readonly TraceTurn[]): number {
  return turns.findLastIndex((turn) => !turn.standalone);
}

export function getActiveConversationTurnIndex(projection: TraceProjection): number {
  const index = projection.activeTurnIndex;
  return index >= 0 && projection.turns[index] && !projection.turns[index].standalone ? index : -1;
}

/** Keep step outcomes scoped to the latest user request, for both trace nodes and stored messages. */
export function latestUserTurnItems<T>(items: readonly T[], isUser: (item: T) => boolean): readonly T[] {
  const index = items.findLastIndex(isUser);
  return index < 0 ? items : items.slice(index);
}
