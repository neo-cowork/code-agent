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

const TABLE_SEPARATOR_LINE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;

/** kept 末尾仍未闭合的围栏代码块：返回开栏行（带 info string），否则 null。 */
function openFenceOf(keptText: string): string | null {
  let open: string | null = null;
  for (const line of keptText.split('\n')) {
    const m = FENCE_LINE.exec(line);
    if (!m) continue;
    open = open === null ? line.trim() : (m[2].trim() === '' && m[1][0] === open[0] ? null : open);
  }
  return open;
}

/**
 * B2 续答与 kept 是两条独立消息、分别渲染。kept 止于"单独无法渲染的块"中间时，续答段会渲染坏：
 * - 表格：续答是裸 `| … |` 行（或从半行接着写）→ 字面竖线。补回表头 + 分隔行（半行则连同 kept 的半行文本）。
 * - 围栏代码块：代码行当正文，收尾围栏又开一个新块吞掉后文。补回同 info string 的开栏。
 * kept 本身一字不改。
 */
function reopenBlockForContinuation(keptText: string, continuation: string): string {
  const fence = openFenceOf(keptText);
  const lastLine = keptText.split('\n').at(-1) ?? '';
  // 续答从 kept 末行的行中接着写（kept 不以换行结尾，续答首个非空白字符既不是换行也不是 `|`）
  const midLine = lastLine.trim() !== '' && !keptText.endsWith('\n') && !/^\s*(\n|\|)/.test(continuation);
  if (fence) {
    const cont = continuation.trimStart();
    if (/^(`{3,}|~{3,})\s*(\n|$)/.test(cont)) return cont.replace(/^[^\n]*\n?/, '');
    if (FENCE_LINE.test(cont.split('\n')[0])) return continuation;
    return `${fence}\n${midLine && !FENCE_LINE.test(lastLine) ? lastLine : ''}${continuation}`;
  }
  const lines = keptText.trimEnd().split('\n');
  let start = lines.length;
  while (start > 0 && lines[start - 1].trimStart().startsWith('|')) start -= 1;
  const block = lines.slice(start).map((l) => l.trim());
  if (block.length === 0) return continuation;
  // 半行：kept 末行是未换行的表格行，续答从行中接着写 → 表头 + 分隔行 + kept 半行 + 续答
  if (midLine && lastLine.trimStart().startsWith('|')) {
    if (block.length < 3 || !TABLE_SEPARATOR_LINE.test(block[1])) return continuation;
    return `${block[0]}\n${block[1]}\n${block.at(-1)}${continuation}`;
  }
  const cont = continuation.trimStart();
  if (!cont.startsWith('|')) return continuation;
  const contLines = cont.split('\n');
  // 续答自己已重开表（首行表头 + 第二行分隔行）：原样放行
  if (contLines[1] !== undefined && TABLE_SEPARATOR_LINE.test(contLines[1].trim())) return continuation;
  const header = block[0];
  // 续答首行是分隔行（模型把断点当成停在表头后）：只补表头
  if (TABLE_SEPARATOR_LINE.test(contLines[0].trim())) {
    return TABLE_SEPARATOR_LINE.test(header) ? continuation : `${header}\n${cont}`;
  }
  if (block.length < 2 || !TABLE_SEPARATOR_LINE.test(block[1])) return continuation;
  return `${header}\n${block[1]}\n${cont}`;
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
  const keptEndsInTable = keptText.trimEnd().split('\n').at(-1)?.trimStart().startsWith('|') ?? false;

  const decide = (): string => {
    decided = true;
    const text = buf.trimStart();
    const p = commonPrefixLength(text, kept);
    const decision = { commonChars: p, keptChars: kept.length };
    const minChars = Math.max(STREAM_B2_DEDUP_MIN_CHARS, Math.ceil(kept.length * STREAM_B2_DEDUP_MIN_RATIO));
    if (p >= minChars) {
      onDecision({ reason: 'restated-trimmed', ...decision });
      return reopenBlockForContinuation(keptText, text.slice(p));
    }
    onDecision({ reason: p === 0 ? 'not-restated' : 'trim-skipped', ...decision });
    return reopenBlockForContinuation(keptText, buf);
  };

  return {
    push(delta) {
      if (decided) return delta;
      buf += delta;
      const text = buf.trimStart();
      if (text.length === 0) return '';
      // 仍是已保留文本的前缀（含恰好等长）：继续暂扣，等分歧或流结束。
      if (kept.startsWith(text)) return '';
      // 续答以表格行开头且 kept 止于表格：再暂扣到前两行都到齐（判断续答是否已自带表头/分隔行）
      if (text.startsWith('|') && keptEndsInTable && text.split('\n').length < 3) return '';
      return decide();
    },
    finish() {
      if (decided || buf === '') return '';
      return decide();
    },
  };
}
