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
