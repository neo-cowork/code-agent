import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { humanizeInternalText, type InternalTextLanguage } from './humanizeInternalText';

const markdown = unified().use(remarkParse);
type MarkdownNode = {
  type: string;
  lang?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};

/** Display projection for explicitly marked host protocols; stored/user-authored text stays intact. */
export function presentReplyBody(input: string, lang: InternalTextLanguage = 'zh', options: {
  protocol?: 'wake' | 'cron';
  isStreaming?: boolean;
} = {}) {
  const technical: string[] = [];
  const reasons: string[] = [];
  const evidence: string[] = [];
  if (!options.protocol) return { text: input, rationale: undefined, evidence: undefined, technicalDetails: undefined };
  const seen = new Set<string>();
  const tagNames = options.protocol === 'cron' ? ['cron_event_decision'] : ['decision', 'rationale', 'evidence'];
  const tags = tagNames.join('|');
  const masked = input.split('');
  const removed: Array<[number, number]> = [];
  const conceal = (start: number, end: number) => {
    technical.push(input.slice(start, end));
    removed.push([start, end]);
    masked.fill('\0', start, end);
  };
  // CommonMark offsets protect fenced (including ~~~/long fences), indented and inline code.
  const protectCode = (node: MarkdownNode) => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      masked.fill('\0', start, end);
      if (options.protocol === 'wake' && node.type === 'code' && node.lang
        && (node.lang === 'wake_proposals' || (options.isStreaming && 'wake_proposals'.startsWith(node.lang)))) {
        const raw = input.slice(start, end);
        const fence = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
        const closed = fence && new RegExp(`(?:^|\\n) {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(raw);
        if (closed || options.isStreaming) conceal(start, end);
      }
      return;
    }
    node.children?.forEach(protectCode);
  };
  protectCode(markdown.parse(input));
  const pattern = new RegExp(`<(${tags})\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi');
  for (const match of masked.join('').matchAll(pattern)) {
    const start = match.index;
    const value = input.slice(start + match[0].indexOf('>') + 1, start + match[0].lastIndexOf('</'));
    const name = match[1].toLowerCase();
    if (name !== 'decision') {
      const clean = humanizeInternalText(value.trim(), lang).text;
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        (name === 'evidence' ? evidence : reasons).push(clean);
      }
    }
    conceal(start, start + match[0].length);
  }
  // Incomplete controls are hidden only while the explicitly marked message is streaming.
  if (options.isStreaming) {
    const pending = new RegExp(`<(?:${tags})\\b(?:[^>]*>[\\s\\S]*|[^>]*)$`, 'i').exec(masked.join(''));
    if (pending) conceal(pending.index, input.length);
    const visible = masked.join('');
    const lastAngle = visible.lastIndexOf('<');
    if (lastAngle >= 0 && tagNames.some((tag) => tag.startsWith(visible.slice(lastAngle + 1).toLowerCase()))) {
      conceal(lastAngle, input.length);
    }
  }
  let cursor = 0;
  let text = '';
  for (const [start, end] of removed.sort((a, b) => a[0] - b[0])) {
    if (start >= cursor) text += input.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  text += input.slice(cursor);
  return {
    text: removed.length ? text.trim() : text,
    rationale: reasons.join('\n') || undefined,
    evidence: evidence.join('\n') || undefined,
    technicalDetails: technical.join('\n') || undefined,
  };
}
