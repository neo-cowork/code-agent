// ============================================================================
// 会话自动标题的小模型提示词（host sessionManager 与 CLI session 同源）
// 标题语言跟随用户首条消息；消息里判不出语言（纯数字/emoji/代码）才回落到 UI 语言。
// ============================================================================

export type SessionTitleLanguage = 'zh' | 'en';

const CJK_CHAR = /[㐀-鿿぀-ヿ가-힯]/g;
const LATIN_CHAR = /[A-Za-zÀ-ɏ]/g;

/** 按字符数判消息主语言：汉字/假名/谚文多于拉丁字母为 zh，反之 en，都没有返回 undefined。 */
export function detectMessageLanguage(message: string): SessionTitleLanguage | undefined {
  const cjk = message.match(CJK_CHAR)?.length ?? 0;
  const latin = message.match(LATIN_CHAR)?.length ?? 0;
  if (cjk === 0 && latin === 0) return undefined;
  return cjk >= latin ? 'zh' : 'en';
}

const LENGTH_HINT: Record<SessionTitleLanguage, string> = {
  zh: '10-25 Chinese characters',
  en: '3-8 English words',
};

const LANGUAGE_NAME: Record<SessionTitleLanguage, string> = {
  zh: 'Chinese',
  en: 'English',
};

export function buildSessionTitlePrompt(message: string, uiLanguage: SessionTitleLanguage): string {
  const detected = detectMessageLanguage(message);
  const language = detected ?? uiLanguage;
  const languageRule = detected
    ? `Write the title in ${LANGUAGE_NAME[detected]}, the same language as the user's message (if the message mixes languages, use its main language).`
    : `The language of the message cannot be determined; write the title in ${LANGUAGE_NAME[uiLanguage]}.`;
  return [
    'Generate a short session title for the following user message.',
    languageRule,
    `Length: ${LENGTH_HINT[language]}. No quotation marks and no trailing punctuation. Output only the title.`,
    '',
    message,
  ].join('\n');
}
