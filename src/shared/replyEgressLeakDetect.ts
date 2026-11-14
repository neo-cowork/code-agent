// 模型面向用户回复的出口泄漏观测（N-UX-HUMAN-LANGUAGE-CORPUS-AUDIT-FU1-REPLY-EGRESS）：
// 复用 detectInternalTextLeaks，并补充机制黑话（mechanism_talk）与对中文用户整段回英文（english_reply_to_zh）。
import { detectInternalTextLeaks, type InternalTextFormat } from './internalTextLeakDetect';

type ReplyEgressLeakCategory =
  | InternalTextFormat
  | 'mechanism_talk'
  | 'english_reply_to_zh';

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const LATIN_WORD_RE = /[A-Za-z\u00C0-\u024F]+(?:[-'][A-Za-z\u00C0-\u024F]+)*/g;

const MIN_ENGLISH_REPLY_CHARS = 30;
const MIN_ENGLISH_WHITESPACE_TOKENS = 6;
// 审计样本如两句工具间英文旁白（"Both mail and calendar connectors are connected. Now let me..."，18 词 / 104 字符），
// 在无 CJK、去代码围栏、>=30 字符且 >=6 空白分词前提下，15 个拉丁词已足以排除短回复与标识符误报。
const MIN_ENGLISH_LATIN_WORDS = 15;
// 带工具调用的回复是工具间旁白：用户盯着这句话等结果，短英文旁白（"I'll first look at what's there..."，10 词）也算错配。
const MIN_ENGLISH_NARRATION_CHARS = 20;
const MIN_ENGLISH_NARRATION_WORDS = 4;
const MAX_TOKEN_SAMPLE_CHARS = 60;
const ENGLISH_SAMPLE_WORD_LIMIT = 5;

const MECHANISM_TALK_REGEXES: readonly RegExp[] = [
  /(?:本轮|这一轮|当前轮次?).{0,12}(?:不可用|没有可用|被禁用|未开放|没有.{0,6}工具)/gi,
  /(?:工具|能力).{0,6}(?:本轮|这一轮|当前轮次?).{0,6}(?:不可用|没有)/gi,
  /(?:shell|终端|命令|Bash)[^，。！？\n]{0,8}(?:被禁用|不可用|跑不了|不能运行|无法运行)/gi,
  /(?:本轮|这一轮|本次(?:运行)?|当前轮次?).{0,6}(?:跑不了|被禁用|不能运行|无法运行)/gi,
  /不在(?:本轮|这一轮|本次(?:运行)?|当前轮次?).{0,6}可用/gi,
  /工具列表(?:里|中)/gi,
  /(?:本轮|这一轮|当前)工具表/gi,
  /系统提示词?|system prompt|被(?:注入|路由)|function call|上下文(?:被)?压缩/gi,
  /\b(?:my|the|current|this\s+(?:turn|run)(?:'s)?)\s+tool\s*(?:list|face|set)\b/gi,
  /\bthis\s+(?:turn|run)(?:'s)?\s+tools?\b.{0,20}\b(?:unavailable|disabled|not\s+available)\b/gi,
  /\b(?:unavailable|disabled|not\s+available)\s+(?:(?:in|for)\s+)?this\s+(?:turn|run)\b/gi,
  /\b(?:Bash|ToolSearch|AskUserQuestion|spawn_agent|delegate_task|browser_action|computer_use)\s+is\s+(?:disabled|unavailable|not\s+(?:available|part\s+of))\b/gi,
];

const EXPLICIT_ENGLISH_REQUEST_REGEXES: readonly RegExp[] = [
  /(?:用|使用|改用|换成|切换(?:到|成)?|说|写|回|回复|回答|输出|生成)(?:纯|全)?英(?:文|语)/i,
  /(?:写|拟|起草|生成|回)[^，。！？\n]{0,8}英(?:文|语)/i,
  /(?:译|翻译)(?:成|为)英(?:文|语)|中译英/i,
  /英(?:文|语)(?:版|版本|回复|回答)/i,
  /\b(?:in|into|use|using|speak|write\s+in|reply\s+in|respond\s+in|answer\s+in|translate(?:\s+(?:it|this))?\s+(?:to|into))\s+english\b/i,
];

function userExplicitlyRequestsEnglish(userText: string): boolean {
  return EXPLICIT_ENGLISH_REQUEST_REGEXES.some((re) => re.test(userText));
}

/**
 * 纯函数观测模型回复文本中的内部格式、机制黑话与语种错配（跳过 ``` 代码围栏内部文本）。
 * 仅返回命中的类别与短匹配片段，绝不携带完整回复正文。
 */
export function detectReplyEgressLeaks(
  replyText: string,
  turnUserText = '',
  opts: { hasToolCalls?: boolean } = {},
): { categories: ReplyEgressLeakCategory[]; matchedTokens: string[] } {
  if (!replyText) {
    return { categories: [], matchedTokens: [] };
  }

  const outsideFences = replyText.replace(FENCED_CODE_RE, ' ');
  const trimmedOutside = outsideFences.trim();
  if (!trimmedOutside) {
    return { categories: [], matchedTokens: [] };
  }

  const categories: ReplyEgressLeakCategory[] = [];
  const matchedTokens: string[] = [];

  const addCategory = (category: ReplyEgressLeakCategory): void => {
    if (!categories.includes(category)) {
      categories.push(category);
    }
  };

  const addToken = (raw: string): void => {
    const token = raw.trim().slice(0, MAX_TOKEN_SAMPLE_CHARS);
    if (token && !matchedTokens.includes(token)) {
      matchedTokens.push(token);
    }
  };

  for (const leak of detectInternalTextLeaks(outsideFences)) {
    addCategory(leak.format);
    addToken(leak.sample);
  }

  for (const regex of MECHANISM_TALK_REGEXES) {
    regex.lastIndex = 0;
    for (const match of outsideFences.matchAll(regex)) {
      if (match[0]) {
        addCategory('mechanism_talk');
        addToken(match[0]);
      }
    }
    regex.lastIndex = 0;
  }

  // Cheap gates first: only inspect turnUserText when reply outside fences has >=30 chars,
  // does not start with `<`, and contains no CJK characters.
  const narration = opts.hasToolCalls === true;
  if (
    trimmedOutside.length >= (narration ? MIN_ENGLISH_NARRATION_CHARS : MIN_ENGLISH_REPLY_CHARS)
    && !trimmedOutside.startsWith('<')
    && !CJK_CHAR_RE.test(trimmedOutside)
  ) {
    if (
      turnUserText
      && CJK_CHAR_RE.test(turnUserText)
      && !userExplicitlyRequestsEnglish(turnUserText)
      && trimmedOutside.split(/\s+/).length >= (narration ? MIN_ENGLISH_NARRATION_WORDS : MIN_ENGLISH_WHITESPACE_TOKENS)
    ) {
      const latinWords = trimmedOutside.match(LATIN_WORD_RE) ?? [];
      if (latinWords.length >= (narration ? MIN_ENGLISH_NARRATION_WORDS : MIN_ENGLISH_LATIN_WORDS)) {
        addCategory('english_reply_to_zh');
        for (const word of latinWords.slice(0, ENGLISH_SAMPLE_WORD_LIMIT)) {
          addToken(word);
        }
      }
    }
  }

  return { categories, matchedTokens };
}
