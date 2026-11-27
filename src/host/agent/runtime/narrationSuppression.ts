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

const CJK_RE = /[\u3400-\u9fff]/;
const ENGLISH_PROBE = 'This is a plain English sentence used to probe the language the user asked for.';

/**
 * 流式侧闸门，判据与落库侧整段判定一致：整段文本（含已扣下的）没有任何 CJK 且被检测器判为
 * 英文旁白时才扣；一旦出现 CJK（说明整段不会被抑制）或检测器不认，已扣下的片段按原序放出，
 * 之后的片段直通——所以中文最终答复、带英文代码行的中文答复不会被卡住。
 * 整轮流结束（settle）时仍在扣的，带工具调用则丢弃，否则（最终答复）原样放出。
 * 用户是英文 / 要求英文时（探针句不被判英文旁白）整个闸门不启用。
 */
export function createNarrationHold(userPrompt: string, emit: (text: string) => void): {
  emit(text: string): void;
  settle(hasToolCalls: boolean): void;
} {
  const held: string[] = [];
  let all = '';
  let passing = !isEnglishNarrationForZh(ENGLISH_PROBE, userPrompt, true);
  const release = (): void => { for (const piece of held.splice(0)) emit(piece); };
  return {
    emit(text) {
      if (passing) { emit(text); return; }
      held.push(text);
      all += text;
      if (!all.trim()) return;
      if (CJK_RE.test(all)) { passing = true; release(); }
    },
    settle(hasToolCalls) {
      if (!(hasToolCalls && isEnglishNarrationForZh(all, userPrompt, true))) release();
      held.length = 0;
    },
  };
}
