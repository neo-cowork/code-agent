import type { Message } from '@shared/contract';
import { isRecord } from './streamEventNormalizers';
import type { AssistantMessagePayload } from './streamEventTypes';

/** 主机封住一批工具调用后合成的工具结果消息（sealBouncedToolCalls、forceFinalSeal 等）。 */
export function isSealedToolResultsMessage(data: unknown): data is Message {
  return isRecord(data) && data.role === 'tool' && typeof data.id === 'string';
}

/**
 * 主机在同一轮里另起的收尾消息（前台拒绝后同轮交给后台任务、重试耗尽的收尾句），按独立消息接下。
 * 一张草稿接下全部提交时，收尾句并进草稿会画在工具步骤上方；落库同步时草稿又被空正文的工具
 * 消息整张认走，库里那条收尾消息落单，同一句话画两遍。判据与 stream_chunk 另起新消息同口径：
 * 草稿的工具调用已出结果，再来的正文就是另一条消息。
 */
export function buildCloseAfterSealedTools(input: {
  draft: Message;
  commit: AssistantMessagePayload;
  now: number;
}): Message | undefined {
  const { draft, commit } = input;
  if (!commit.id || commit.id === draft.id || commit.toolCalls?.length) return undefined;
  if (!draft.toolCalls?.some((toolCall) => toolCall.result !== undefined)) return undefined;
  return {
    id: commit.id,
    role: 'assistant',
    content: commit.content ?? '',
    timestamp: input.now,
    metadata: { correlation: { turnId: draft.id }, ...commit.metadata },
    ...(commit.reasoning !== undefined ? { reasoning: commit.reasoning } : {}),
    ...(commit.thinking !== undefined ? { thinking: commit.thinking } : {}),
    ...(commit.contentParts ? { contentParts: commit.contentParts } : {}),
    ...(commit.artifacts ? { artifacts: commit.artifacts } : {}),
    ...(commit.modelDecision ? { modelDecision: commit.modelDecision } : {}),
  };
}
