import table from './settingsTerms.json';
import { getProviderInfo } from '@shared/constants';
import type { ModelProvider } from '@shared/contract';

type SettingsLanguage = 'zh' | 'en';

function word(id: string, language: SettingsLanguage): string {
  const entry = table.terms.find((term) => term.id === id);
  if (!entry) throw new Error(`Missing settings term: ${id}`);
  return language === 'zh' ? entry.human : entry.term;
}

export function getSettingsVocabulary(language: SettingsLanguage) {
  return {
    provider: word('provider', language),
    baseUrl: word('baseUrl', language),
    keyLabel: word('keyLabel', language),
    addressHint: language === 'zh'
      ? `粘贴${word('provider', language)}提供的${word('baseUrl', language)}（例如以 /v1 结尾的网址），使用 Claude 的服务请填它提供的 Claude 接口地址。`
      : 'Paste the service endpoint, for example a URL ending in /v1; for Claude, use the Claude endpoint supplied by the service.',
  };
}

/** Translate catalog defaults at the display boundary; preserve names chosen by users. */
export function getProviderDisplayName(
  id: ModelProvider,
  configuredName: string | undefined,
  fallbackName: string,
  language: SettingsLanguage,
): string {
  const defaultName = getProviderInfo(id)?.displayName;
  if (language === 'en') return configuredName || fallbackName || defaultName || id;
  if (configuredName && configuredName !== defaultName) return configuredName;
  if (id === 'custom' && language === 'zh' && (!fallbackName || fallbackName === defaultName)) {
    return `自定义${getSettingsVocabulary(language).provider}`;
  }
  return fallbackName || defaultName || id;
}
