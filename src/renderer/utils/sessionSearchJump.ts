import type { TraceNode, TraceProjection } from '@shared/contract/trace';
import type { CrossSessionSearchResultItem } from '@shared/ipc/types';
import type { SearchMatch } from '../components/features/chat/ChatSearchBar';
import type { PendingSessionSearchJump } from '../stores/sessionUIStore';

/**
 * 会话内搜索/命中跳转能看到的节点文本：工具调用节点的 content 常为空，
 * 用户记得的内容（命令输出、读到的文件）在 toolCall.result 里。
 */
export function getTraceNodeSearchText(node: TraceNode): string {
  const result = node.toolCall?.result;
  return typeof result === 'string' && result ? `${node.content}\n${result}` : node.content;
}

export function createPendingSearchJumpFromCrossSessionResult(
  result: CrossSessionSearchResultItem,
  query: string,
  createdAt = Date.now(),
): PendingSessionSearchJump {
  return {
    sessionId: result.sessionId,
    messageId: result.messageId,
    messageIndex: result.messageIndex,
    turnNumber: result.turnNumber,
    matchOffset: result.matchOffset,
    query: query.trim(),
    createdAt,
  };
}

function findQueryInTurn(
  projection: TraceProjection,
  turnIndex: number,
  query: string,
): SearchMatch | null {
  const turn = projection.turns[turnIndex];
  if (!turn || !query) return null;

  for (let nodeIndex = 0; nodeIndex < turn.nodes.length; nodeIndex += 1) {
    const node = turn.nodes[nodeIndex];
    const offset = getTraceNodeSearchText(node).toLowerCase().indexOf(query);
    if (offset >= 0) {
      return { turnIndex, nodeIndex, offset };
    }
  }

  return null;
}

export function findSearchMatchForPendingJump(
  projection: TraceProjection,
  jump: PendingSessionSearchJump,
): SearchMatch | null {
  if (projection.sessionId !== jump.sessionId) {
    return null;
  }

  const query = jump.query.trim().toLowerCase();
  let fallback: SearchMatch | null = null;
  const targetTurnIndex = typeof jump.turnNumber === 'number'
    ? projection.turns.findIndex((turn) => turn.turnNumber === jump.turnNumber)
    : -1;

  if (jump.messageId) {
    for (let turnIndex = 0; turnIndex < projection.turns.length; turnIndex += 1) {
      const turn = projection.turns[turnIndex];
      for (let nodeIndex = 0; nodeIndex < turn.nodes.length; nodeIndex += 1) {
        const node = turn.nodes[nodeIndex];
        if (node.messageId !== jump.messageId && node.id !== jump.messageId) {
          continue;
        }

        const content = getTraceNodeSearchText(node).toLowerCase();
        const queryOffset = query ? content.indexOf(query) : -1;
        if (query && queryOffset === -1) {
          fallback ??= { turnIndex, nodeIndex, offset: 0 };
          continue;
        }

        const preferredOffset = typeof jump.matchOffset === 'number' ? jump.matchOffset : -1;
        const offset = queryOffset >= 0
          ? queryOffset
          : preferredOffset >= 0 && preferredOffset < content.length
            ? preferredOffset
            : 0;

        return {
          turnIndex,
          nodeIndex,
          offset: Math.max(0, offset),
        };
      }
    }

    if (fallback) {
      return fallback;
    }
  }

  if (targetTurnIndex >= 0) {
    const turnMatch = findQueryInTurn(projection, targetTurnIndex, query);
    if (turnMatch) {
      return turnMatch;
    }
  }

  for (let turnIndex = 0; turnIndex < projection.turns.length; turnIndex += 1) {
    const turnMatch = findQueryInTurn(projection, turnIndex, query);
    if (turnMatch) {
      return turnMatch;
    }
  }

  return null;
}
