import { humanizeInternalText, type InternalTextLanguage } from './humanizeInternalText';

/** Display projection only: never write this result back into stored messages. */
export function presentReplyBody(input: string, lang: InternalTextLanguage = 'zh') {
  const technical: string[] = [];
  const reasons: string[] = [];
  const evidence: string[] = [];
  const seen = new Set<string>();
  const tagNames = ['decision', 'rationale', 'evidence', 'cron_event_decision'];
  const tags = tagNames.join('|');
  const pattern = new RegExp(`<(${tags})\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi');
  let text = input.replace(pattern, (raw: string, tag: string, value: string) => {
    technical.push(raw);
    const name = tag.toLowerCase();
    if (name !== 'decision') {
      const clean = humanizeInternalText(value.trim(), lang).text;
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        (name === 'evidence' ? evidence : reasons).push(clean);
      }
    }
    return '';
  });
  // A streaming prefix must not flash raw tags before its closing tag arrives.
  text = text.replace(new RegExp(`<(?:${tags})(?:\\b[^>]*>[\\s\\S]*|[^>]*)$`, 'i'), (raw) => {
    technical.push(raw);
    return '';
  });
  // Also hide partially received tag names without suppressing ordinary prose.
  const lastAngle = text.lastIndexOf('<');
  if (lastAngle >= 0 && tagNames.some((tag) => tag.startsWith(text.slice(lastAngle + 1).toLowerCase()))) {
    technical.push(text.slice(lastAngle));
    text = text.slice(0, lastAngle);
  }
  return {
    text: technical.length ? text.trim() : text,
    rationale: reasons.join('\n') || undefined,
    evidence: evidence.join('\n') || undefined,
    technicalDetails: technical.join('\n') || undefined,
  };
}
