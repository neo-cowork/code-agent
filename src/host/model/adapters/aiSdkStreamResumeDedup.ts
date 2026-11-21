// ADR-068 as-built 9：B2 断流后的续答请求提示 + 宿主侧"复述开头"裁剪。
// B2 重发请求与原请求逐字相同，模型不知道用户已看到什么，会整篇重写；这里在请求末尾追加
// （仅请求，不落库、不展示）assistant=已保留文本 + user=续写指令，并对续答开头做前缀去重。
import type { ModelMessage as AiModelMessage } from 'ai';
import { STREAM_B2_DEDUP_MIN_CHARS, STREAM_B2_DEDUP_MIN_RATIO } from '../../../shared/constants';
import type { AiSdkPromptShape } from './aiSdkPromptBuilder';

const CONTINUATION_HINT = [
  'Your previous response was cut off by a connection error. The assistant message above is the part the user has already seen.',
  'Continue from exactly where it stopped. Do not repeat or restate any earlier text, do not restart, and do not apologize.',
].join(' ');

/** 已保留文本为空（断流发生在 reasoning 阶段）时不加后缀。前缀部分逐字不变（prompt cache 前提）。 */
export function withB2ContinuationHint(prompt: AiSdkPromptShape, keptText: string): AiSdkPromptShape {
  if (!keptText) return prompt;
  return {
    ...prompt,
    messages: [
      ...prompt.messages,
      { role: 'assistant', content: keptText } as AiModelMessage,
      { role: 'user', content: CONTINUATION_HINT } as AiModelMessage,
    ],
  };
}

type B2DedupReason = 'restated-trimmed' | 'not-restated' | 'trim-skipped';

interface B2DedupDecision {
  reason: B2DedupReason;
  /** 公共前缀长度（restated-trimmed 时即被裁掉的字符数，含续答开头空白）。 */
  commonChars: number;
  keptChars: number;
}

export interface B2DedupGate {
  /** 喂入 text delta，返回可以向外放行的文本（可能为空串 = 暂扣）。 */
  push(delta: string): string;
  /** 流结束 / 遇到工具调用时定案，返回暂扣的剩余文本。 */
  finish(): string;
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

export function createB2DedupGate(
  keptText: string,
  onDecision: (decision: B2DedupDecision) => void,
): B2DedupGate {
  const kept = keptText.trimStart();
  let buf = '';
  let decided = false;

  const decide = (): string => {
    decided = true;
    const text = buf.trimStart();
    const p = commonPrefixLength(text, kept);
    const decision = { commonChars: p, keptChars: kept.length };
    const minChars = Math.max(STREAM_B2_DEDUP_MIN_CHARS, Math.ceil(kept.length * STREAM_B2_DEDUP_MIN_RATIO));
    if (p >= minChars) {
      onDecision({ reason: 'restated-trimmed', ...decision });
      return text.slice(p);
    }
    onDecision({ reason: p === 0 ? 'not-restated' : 'trim-skipped', ...decision });
    return buf;
  };

  return {
    push(delta) {
      if (decided) return delta;
      buf += delta;
      const text = buf.trimStart();
      if (text.length === 0) return '';
      // 仍是已保留文本的前缀（含恰好等长）：继续暂扣，等分歧或流结束。
      if (kept.startsWith(text)) return '';
      return decide();
    },
    finish() {
      if (decided || buf === '') return '';
      return decide();
    },
  };
}
