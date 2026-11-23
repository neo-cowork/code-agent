import type { TraceTurn } from '@shared/contract/trace';

/** 同会话后台任务在账本里的事实：创建时间 + 是否仍未结束。 */
interface BackgroundTaskFact {
  createdAt: number;
  live: boolean;
}

export interface BackgroundBusyFacts {
  tasks: readonly BackgroundTaskFact[];
  /** 已交接调用已出现、任务还没进渲染端账本，且仍在宽限期内：后台通道视为仍持有进行中态。 */
  awaitingLedger?: boolean;
}

/** 本轮里第一个已交接后台的调用 id（结果码 HANDED_OFF_TO_BACKGROUND）。 */
export function findHandedOffCallId(turn: TraceTurn): string | undefined {
  return turn.nodes.find((node) => (
    node.type === 'tool_call' && node.toolCall?.metadata?.code === 'HANDED_OFF_TO_BACKGROUND'
  ))?.toolCall?.id;
}

/**
 * 一轮只允许一个进行中信号，由 TurnCard 决定它落在哪个现有组件里。
 * `background`：本轮有已交接后台的调用时，本轮开始后创建的任务仍存活、或任务尚未到账本（宽限内），
 * 后台通道承担进行中态；任务一旦终态就回到通用信号。
 */
export function resolveBusySignal(
  turn: TraceTurn,
  background?: BackgroundBusyFacts,
): 'thinking' | 'text-caret' | 'tool' | 'none' {
  if (turn.status !== 'streaming') return 'none';

  // 工具执行优先于尾部合成的空 assistant 节点：步骤行已经承担进行中态，
  // 此时不能再让通用流式光标补一个「还在忙」信号。
  const hasRunningTool = turn.nodes.some((node) => (
    node.type === 'tool_call'
    && Boolean(node.toolCall)
    && node.toolCall?.result === undefined
  ));
  if (hasRunningTool) return 'tool';

  if (background && findHandedOffCallId(turn) !== undefined) {
    const mine = background.tasks.filter((task) => task.createdAt >= turn.startTime);
    if (mine.some((task) => task.live)) return 'tool';
    if (mine.length === 0 && background.awaitingLedger) return 'tool';
  }

  for (let index = turn.nodes.length - 1; index >= 0; index -= 1) {
    const node = turn.nodes[index];
    if (node.type === 'assistant_text') {
      if (node.content?.trim()) return 'text-caret';
      if ((node.thinking || node.reasoning)?.trim()) return 'thinking';
      continue;
    }
    // 已完成工具会结束它之前的 reasoning 段；下一阶段是在等模型继续出字。
    if (node.type === 'tool_call') return 'text-caret';
  }

  // 首 token 前、工具收尾后等待模型继续输出，都沿用已有通用文本光标。
  return 'text-caret';
}
