import { splitChannelSessionTitle } from '../../shared/channelSessionTitle';
import { humanizeInternalText } from '../../shared/humanizeInternalText';
import { CALL_ID_GLOBAL_RE, OU_ID_GLOBAL_RE, SESSION_ID_GLOBAL_RE, UUID_GLOBAL_RE } from '../../shared/internalTextLeakDetect';
import { readUiLanguage } from './sessionTitleHostPrompt';

const ID_PATTERNS = [UUID_GLOBAL_RE, SESSION_ID_GLOBAL_RE, CALL_ID_GLOBAL_RE, OU_ID_GLOBAL_RE];
const ID_MARK = '\uE000';
const BRACKETED_ID = /\s*[（(\[【][^（()）[\]【】]*\uE000[^（()）[\]【】]*[）)\]】]/g;
const EDGE_SEPARATORS = /^[\s\-–—·:：,，、]+|[\s\-–—·:：,，、]+$/g;

/**
 * A pasted id says nothing in a name: drop it (with the bracketed aside that only labelled it)
 * instead of swapping in a placeholder word. Returns '' when the name is nothing but ids.
 */
function dropPastedIds(name: string): string {
  let marked = name;
  for (const pattern of ID_PATTERNS) marked = marked.replace(new RegExp(pattern.source, pattern.flags), ID_MARK);
  if (!marked.includes(ID_MARK)) return name;
  const cleaned = marked
    .replace(BRACKETED_ID, ' ')
    .replaceAll(ID_MARK, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(EDGE_SEPARATORS, '');
  return cleaned;
}

/**
 * Humanize names before persistence so exports and copies share the same copy.
 * `idOnly: 'keep'` (session titles): a title that is nothing but an id has no human part to keep, and
 * readers that treat an id-only title as "untitled" (parked approvals, the sidebar) must still recognise it.
 */
export function humanizeStoredName(name: string, idOnly: 'placeholder' | 'keep' = 'placeholder'): string {
  const channel = splitChannelSessionTitle(name);
  const cleaned = channel ? `${channel.prefix}${channel.name}`.trim() : name;
  const withoutIds = dropPastedIds(cleaned);
  if (!withoutIds && idOnly === 'keep') return cleaned;
  return humanizeInternalText(withoutIds || cleaned, readUiLanguage()).text;
}
