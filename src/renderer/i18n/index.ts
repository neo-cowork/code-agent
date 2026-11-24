// ============================================================================
// Internationalization (i18n) - 国际化
// ============================================================================

import { zh, type Translations } from './zh';
import { en } from './en';

export type Language = 'zh' | 'en';

export const languages: Record<Language, Translations> = {
  zh,
  en,
};

export const defaultLanguage: Language = 'zh';

const LANGUAGE_STORAGE_KEY = 'code-agent-language';

// <html lang> 需要 BCP47 标签；Language 是内部短码（zh -> zh-CN，en -> en）
const DOCUMENT_LANG_TAGS: Record<Language, string> = {
  zh: 'zh-CN',
  en: 'en',
};

// 同步 <html lang>：读屏、拼写检查、连字符与 CJK 字体回退都按它选语言。
// 非 DOM 环境（Node 侧 import i18n 常量时）没有 document，直接跳过。
export function applyDocumentLanguage(language: Language): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.lang = DOCUMENT_LANG_TAGS[language];
}

export function readStoredLanguage(): Language | null {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return stored !== null && stored in languages ? (stored as Language) : null;
  } catch {
    return null;
  }
}

export function storeLanguage(language: Language): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // 无痕模式或存储被禁时静默：后端设置仍是真源，本地快照丢了只是回退默认语言
  }
}

export type { Translations };
export { zh, en };
