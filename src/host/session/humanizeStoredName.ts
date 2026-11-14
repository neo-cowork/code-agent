import { splitChannelSessionTitle } from '../../shared/channelSessionTitle';
import { humanizeInternalText } from '../../shared/humanizeInternalText';
import { readUiLanguage } from './sessionTitleHostPrompt';

/** Humanize names before persistence so exports and copies share the same copy. */
export function humanizeStoredName(name: string): string {
  const channel = splitChannelSessionTitle(name);
  const cleaned = channel ? `${channel.prefix}${channel.name}`.trim() : name;
  return humanizeInternalText(cleaned, readUiLanguage()).text;
}
