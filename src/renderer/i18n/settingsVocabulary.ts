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

const literalPattern = new RegExp(`(${table.literals.map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);

/**
 * Host- and data-supplied text (doctor checks, inventories) reaches the zh UI through this
 * boundary. English output and fully English sentences are returned untouched; verbatim
 * literals such as a header name are never rewritten.
 */
export function localizeSettingsTerms(text: string, language: SettingsLanguage): string {
  if (language !== 'zh' || !text) return text;
  const phrase = table.phrases.find((entry) => entry.text === text);
  if (phrase) return phrase.human;
  if (!/[\u3400-\u9fff]/.test(text)) return text;
  return text.split(literalPattern).map((segment, index) => {
    if (index % 2 === 1) return segment;
    return table.terms.filter((term) => term.mode === 'enforce').reduce((result, term) => {
      const body = term.term.split(/\s+/).join('[\\s-]*');
      return result.replace(new RegExp(`( ?)(?<![A-Za-z])${body}s?(?![A-Za-z])( ?)`, 'gi'), (match: string, before: string, after: string, offset: number, whole: string) => {
        // Chinese has no space next to a Chinese word; keep it beside punctuation and Latin text.
        const keepBefore = before && /[^\u3400-\u9fff]/.test(whole[offset - 1] ?? '');
        const keepAfter = after && /[^\u3400-\u9fff]/.test(whole[offset + match.length] ?? '');
        return `${keepBefore ? before : ''}${term.human}${keepAfter ? after : ''}`;
      });
    }, segment);
  }).join('');
}
