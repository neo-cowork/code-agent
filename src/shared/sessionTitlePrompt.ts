// ============================================================================
// 会话自动标题的小模型提示词（host sessionManager 与 CLI session 同源）
// 标题语言跟随用户首条消息；消息里写了明确的回复语言指令（“请用中文回复” / “reply in English”）时，指令优先；消息里判不出语言（纯数字/emoji/代码）才回落到 UI 语言。
// ============================================================================

export type SessionTitleLanguage = 'zh' | 'en';

const CJK_CHAR = /[㐀-鿿豈-﫿぀-ヿ가-힯]/g;
const LATIN_WORD = /[A-Za-zÀ-ɏ]+(?:[-'][A-Za-zÀ-ɏ]+)*/g;

const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;
const URL_SPAN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const BOUNDED_PATH_BEFORE_CJK =
  /(^|[\s,;:!?"'()[\]{}<>，。；：！？、“”‘’（）【】《》])(?:~\/|\.{1,2}\/|\/|[A-Za-z]:\\)[^\s,;:!?"'()[\]{}<>，。；：！？、“”‘’（）【】《》]*?\.(?:[a-z][a-z0-9]{0,7}|[A-Z][A-Z0-9]{0,5})(?=[㐀-鿿豈-﫿぀-ヿ가-힯])/g;
const BOUNDED_PATH =
  /(^|[\s,;:!?"'()[\]{}<>，。；：！？、“”‘’（）【】《》])(?:~\/|\.{1,2}\/|\/|[A-Za-z]:\\)[^\s,;:!?"'()[\]{}<>，。；：！？、“”‘’（）【】《》]+/g;
const BOUNDED_FILENAME =
  /([\s"'([{<])[^\s,;:!?"'()[\]{}<>，。；：！？、“”‘’（）【】《》/\\]+\.(?:[a-z][a-z0-9]{0,7}|[A-Z][A-Z0-9]{0,5})(?=$|[\s,;:!?"'()[\]{}<>，。；：！？、“”‘’（）【】《》])/g;
const INLINE_ASCII_PATH =
  /(?<![A-Za-z0-9_])(?:~\/|\.{1,2}\/|\/)[A-Za-z0-9._~/-]*|[A-Za-z]:\\[A-Za-z0-9._~\\-]*/g;
const RELATIVE_MULTI_SLASH_PATH = /\b[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){2,}\b/g;
const RELATIVE_FILE_PATH = /\b[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+\b/g;
const CLI_COMMAND_SPAN =
  /\b(?:(?:npm|pnpm|yarn|bun)[ \t]+(?:run|install|add|remove|ci|test|build|start|exec|dlx|init|publish)|npx[ \t]+[a-z0-9@._/-]+|git[ \t]+(?:status|diff|log|show|add|rm|mv|commit|push|pull|fetch|checkout|switch|branch|merge|rebase|reset|stash|clone|tag|cherry-pick|rev-parse|clean)|docker[ \t]+(?:compose|run|build|ps|logs|exec|pull|push|stop|rm|rmi|images))(?:[ \t]+(?:--?[A-Za-z0-9][A-Za-z0-9_-]*|[a-z0-9@._:/~][a-z0-9@._:/~-]*))*/g;
const DOTTED_TOKEN = /\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+\b|\.(?:[a-z][a-z0-9]{0,7}|[A-Z][A-Z0-9]{0,5})\b/g;
const CLI_FLAG = /(?<![A-Za-z0-9])--?[A-Za-z0-9][A-Za-z0-9_-]*/g;
const IDENTIFIER_TOKEN = /\b[A-Za-z0-9]*(?:_[A-Za-z0-9_]+|:[A-Za-z0-9:_-]+)\b/g;
const ALNUM_MIXED_TOKEN = /\b(?:[A-Za-z]+\d+|\d+[A-Za-z]+)[A-Za-z0-9_-]*\b/g;

/** 剥离代码块、URL、文件路径、文件名与命令行片段，只留自然语言正文参与语种判断。 */
function stripNonProseSpans(message: string): string {
  return message
    .replace(FENCED_CODE, ' ')
    .replace(INLINE_CODE, ' ')
    .replace(URL_SPAN, ' ')
    .replace(BOUNDED_PATH_BEFORE_CJK, '$1 ')
    .replace(BOUNDED_PATH, '$1 ')
    .replace(BOUNDED_FILENAME, '$1 ')
    .replace(INLINE_ASCII_PATH, ' ')
    .replace(RELATIVE_MULTI_SLASH_PATH, ' ')
    .replace(RELATIVE_FILE_PATH, ' ')
    .replace(CLI_COMMAND_SPAN, ' ')
    .replace(DOTTED_TOKEN, ' ')
    .replace(CLI_FLAG, ' ')
    .replace(IDENTIFIER_TOKEN, ' ')
    .replace(ALNUM_MIXED_TOKEN, ' ');
}

// 只认祈使式：中文“用/以”前不能是“所/应/使…”这类构词字（挡“所以英文回答”“应用英文回复”），指令前紧邻否定词则忽略；
// 英文动词前必须是句首/标点或 please/to/and 等祈使引导词（挡 “The answer in Chinese”“don't reply in English”）。
const ZH_REPLY_DIRECTIVE =
  /(?<![所应使可利引采作适足得难加予借据何申户])(?:请?(?:使用|采用|用|以)|请)(简体中文|繁体中文|中文|汉语|英文|英语)(?:来)?(?:回复|回答|答复|作答|回应)/g;
// 指令前紧邻否定（不要/不需要/不必/不用/别/勿/没有/非/无需）则不是指令
const ZH_NEGATED_LEAD = /(?:[不别勿没非](?:要|需要?|必|用|须|想|有)?|无需)$/;
const EN_REPLY_DIRECTIVE =
  /(?<=^|[.!?;:,\n]\s*|\b(?:please|kindly|and|then|also|just|always|to|you)\s+)(?:reply|respond|answer)(?:\s+to\s+me)?\s+in\s+(Chinese|Mandarin|English)\b/gi;

function directiveLanguage(name: string): SessionTitleLanguage {
  return /^(?:英文|英语|english)$/i.test(name) ? 'en' : 'zh';
}

/** 显式回复语言指令；多条冲突时取位置最靠后的一条。 */
function detectReplyDirective(message: string): SessionTitleLanguage | undefined {
  const code = message.replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ');
  let last: { index: number; lang: SessionTitleLanguage } | undefined;
  for (const re of [ZH_REPLY_DIRECTIVE, EN_REPLY_DIRECTIVE]) {
    for (const m of code.matchAll(re)) {
      if (re === ZH_REPLY_DIRECTIVE && ZH_NEGATED_LEAD.test(code.slice(Math.max(0, m.index - 3), m.index))) continue;
      if (!last || m.index > last.index) last = { index: m.index, lang: directiveLanguage(m[1]) };
    }
  }
  return last?.lang;
}

/** 剥离路径/命令/代码后判消息语言：显式回复语言指令优先；否则按词级单位比较，中日韩字数不少于拉丁词数为 zh，反之为 en，无自然语言正文返回 undefined。 */
export function detectMessageLanguage(message: string): SessionTitleLanguage | undefined {
  const directive = detectReplyDirective(message);
  if (directive) return directive;
  const prose = stripNonProseSpans(message);
  const cjk = prose.match(CJK_CHAR)?.length ?? 0;
  const latinWords = prose.match(LATIN_WORD)?.length ?? 0;
  if (cjk === 0 && latinWords === 0) return undefined;
  return cjk >= latinWords ? 'zh' : 'en';
}

const LENGTH_HINT: Record<SessionTitleLanguage, string> = {
  zh: '10-25 Chinese characters',
  en: '3-8 English words',
};

const LANGUAGE_NAME: Record<SessionTitleLanguage, string> = {
  zh: 'Chinese',
  en: 'English',
};

const STRICT_RETRY_RULE =
  'Your previous title copied the user\'s wording. Do NOT reuse any phrase from the message; rewrite it as a noun phrase naming the topic, starting with a different word.';

export function buildSessionTitlePrompt(message: string, uiLanguage: SessionTitleLanguage, strict = false): string {
  const detected = detectMessageLanguage(message);
  const language = detected ?? uiLanguage;
  const languageRule = detected
    ? `Write the title in ${LANGUAGE_NAME[detected]}, the same language as the user's message (if the message mixes languages, use its main language).`
    : `The language of the message cannot be determined; write the title in ${LANGUAGE_NAME[uiLanguage]}.`;
  return [
    'Generate a short session title for the following user message.',
    languageRule,
    `Length: ${LENGTH_HINT[language]}. No quotation marks and no trailing punctuation. Output only the title.`,
    'Summarize the topic as a short noun phrase. Never copy or truncate the user\'s wording, and do not start with 请 / 帮我 / please.',
    'Examples: "请帮我分析这个 sales.csv，按地区汇总金额" -> 销售数据按地区汇总; "Can you help me draft a weekly report about the release" -> Weekly release report draft',
    ...(strict ? [STRICT_RETRY_RULE] : []),
    '',
    message,
  ].join('\n');
}
