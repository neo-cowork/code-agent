import { humanizeInternalText } from '../../shared/humanizeInternalText';
import { readUiLanguage } from './sessionTitleHostPrompt';

/** Humanize names before persistence so exports and copies share the same copy. */
export function humanizeStoredName(name: string): string {
  return humanizeInternalText(name, readUiLanguage()).text;
}
