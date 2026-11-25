import type { Message } from '../../../shared/contract';
import { detectReplyEgressLeaks } from '../../../shared/replyEgressLeakDetect';

/**
 * 中文对话里，工具调用间的英文过渡句不给用户看（不翻译、不重写，原文留在 metadata）。
 * 只认「带工具调用 + english_reply_to_zh」；最终答复与用户要求英文的情形仍走观测。
 */
function isEnglishNarrationForZh(content: string, userPrompt: string, hasToolCalls: boolean): boolean {
  if (!hasToolCalls || !content) return false;
  return detectReplyEgressLeaks(content, userPrompt, { hasToolCalls: true }).categories.includes('english_reply_to_zh');
}

/** 落库/发事件给用户看的副本：被抑制的旁白正文清空，原文放 metadata。内存里给模型的原消息不动。 */
export function userFacingMessage(message: Message): Message {
  if (!message.metadata?.narrationSuppressed) return message;
  return {
    ...message,
    content: '',
    ...(message.contentParts
      ? { contentParts: message.contentParts.map((part) => (part.type === 'text' ? { ...part, text: '' } : part)) }
      : {}),
    metadata: { ...message.metadata, suppressedNarration: message.content },
  };
}

/**
 * 流式侧闸门：一整句英文候选句先扣下，之后的句子也排在它后面（保序）；
 * 整轮流结束时才知道有没有工具调用——有则丢弃候选句，没有（最终答复）则原样放出。
 */
export function createNarrationHold(userPrompt: string, emit: (text: string) => void): {
  emit(text: string): void;
  settle(hasToolCalls: boolean): void;
} {
  const held: Array<{ text: string; english: boolean }> = [];
  return {
    emit(text) {
      const english = isEnglishNarrationForZh(text, userPrompt, true);
      if (held.length > 0 || english) held.push({ text, english });
      else emit(text);
    },
    settle(hasToolCalls) {
      for (const piece of held.splice(0)) {
        if (!(hasToolCalls && piece.english)) emit(piece.text);
      }
    },
  };
}
