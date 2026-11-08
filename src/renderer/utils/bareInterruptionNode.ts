// 重载视图里「只剩中断标记」的助手行（用户在模型首字前停止 / 切换会话）：
// 正文被渲染层剥空，又没有 recovery 快照或工具节点承载中断信号，整轮会是一片空白。
// 这里为它补一个空正文节点，由 TraceNodeRenderer 按本地化“已停止”文案渲染。
import type { Message, StreamInterruptionReason } from '@shared/contract';
import type { TraceNode } from '@shared/contract/trace';
import { isStreamRecoveryMessage } from './streamRecoveryMessage';

const PROTOCOL_MARKERS = /\[cancelled\]|\[未完成\s*[—-]\s*切换会话中断\]/giu;

function hasStreamRecoveryInSameTurn(msg: Message, all: Message[]): boolean {
  const messageIndex = all.indexOf(msg);
  if (messageIndex < 0) return false;

  let turnStart = 0;
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    if (all[index].role === 'user') {
      turnStart = index;
      break;
    }
  }

  let turnEnd = all.length;
  for (let index = messageIndex + 1; index < all.length; index += 1) {
    if (all[index].role === 'user') {
      turnEnd = index;
      break;
    }
  }

  return all.slice(turnStart, turnEnd).some((message) => isStreamRecoveryMessage(message));
}

function hasCompletedBackgroundTaskResultInTurn(msg: Message, all: Message[]): boolean {
  const messageIndex = all.indexOf(msg);
  if (messageIndex < 0) return false;

  const isVisibleUser = (candidate: Message): boolean => (
    candidate.role === 'user' && !candidate.isMeta && candidate.visibility !== 'rewound'
  );
  const isBackgroundWake = (candidate: Message): boolean => (
    candidate.role === 'user'
    && candidate.isMeta === true
    && (
      candidate.metadata?.automation?.automationType === 'role_wake'
      || /后台任务|后台检查|任务结果|background task completed|<system-reminder>/iu.test(candidate.content)
    )
  );
  let hasBackgroundWake = false;
  let hasCompletedResult = false;
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const candidate = all[index];
    if (isVisibleUser(candidate)) break;
    hasBackgroundWake ||= isBackgroundWake(candidate);
    hasCompletedResult ||= candidate.role === 'system'
      && candidate.metadata?.backgroundTaskResult?.status === 'completed';
  }
  for (let index = messageIndex + 1; index < all.length; index += 1) {
    const candidate = all[index];
    if (isVisibleUser(candidate)) break;
    hasBackgroundWake ||= isBackgroundWake(candidate);
    hasCompletedResult ||= candidate.role === 'system'
      && candidate.metadata?.backgroundTaskResult?.status === 'completed';
  }
  return hasBackgroundWake && hasCompletedResult;
}

export function bareInterruptionNode(
  msg: Message,
  all: Message[],
  reason: StreamInterruptionReason,
): TraceNode | null {
  if (reason !== 'user' && reason !== 'session-switch') return null;
  if (isStreamRecoveryMessage(msg) || msg.toolCalls?.length) return null;
  if (msg.content.replace(PROTOCOL_MARKERS, '').trim()) return null;
  if (hasStreamRecoveryInSameTurn(msg, all)) return null;
  // 后台任务收口可能与仍在轮询的前台 run 交错落库：旧 run 的裸 [cancelled] 既可能
  // 在权威 system 结果之前，也可能在其之后。只有同一轮同时带有后台唤醒标记和
  // completed 结果时，它才是内部抢占痕迹；孤立的 completed 任务不能吞掉真实用户停止。
  if (reason === 'user' && hasCompletedBackgroundTaskResultInTurn(msg, all)) return null;
  return {
    id: `${msg.id}-text`,
    messageId: msg.id,
    type: 'assistant_text',
    content: '',
    timestamp: msg.timestamp,
    metadata: { ...msg.metadata, streamInterruptionReason: reason },
  };
}

// 空正文 + 中断原因 = 只承载“已停止”提示的节点；它不是真正的断流信号，
// TurnCard 判定「本轮是否被中断」时要排除它，否则用户停止过的轮次会丢改动摘要。
export function isBareInterruptionNode(node: TraceNode): boolean {
  return node.type === 'assistant_text'
    && !node.content
    && !node.metadata?.agentError
    && !node.metadata?.streamRecovery
    && Boolean(node.metadata?.streamInterruptionReason);
}
