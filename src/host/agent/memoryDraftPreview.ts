import {
  getProposeProjectMemoryPreviewMessages,
  PROJECT_MEMORY_TOPIC_ORDER,
  type ProposeProjectMemoryPreviewLocale,
} from '../../shared/i18n/proposeProjectMemoryPreview';

const MEMORY_DRAFT_PREVIEW_CAP = 1500;

/** 在 cap 内按 段落 > 句末 > 换行 > 空白 的顺序找最靠后的边界；都没有才硬切。 */
function cutAtBoundary(text: string, cap: number): string {
  const head = text.slice(0, cap);
  const floor = Math.floor(cap / 2);
  // keepMatch：句末标点留在正文里；其余分隔符在分隔处切。
  const boundaries = [
    { pattern: /\n\s*\n/g, keepMatch: false },
    { pattern: /[。！？!?]|[.;；](?=\s|$)/g, keepMatch: true },
    { pattern: /\n/g, keepMatch: false },
    { pattern: /\s/g, keepMatch: false },
  ];
  for (const { pattern, keepMatch } of boundaries) {
    let end = -1;
    for (const m of head.matchAll(pattern)) {
      const stop = keepMatch ? m.index + m[0].length : m.index;
      if (stop >= floor) end = stop;
    }
    if (end > 0) return head.slice(0, end).trimEnd();
  }
  return head.trimEnd();
}

export function buildMemoryDraftPreview(
  params: Record<string, unknown>,
  content: string,
  locale: ProposeProjectMemoryPreviewLocale,
): { summary: string; diff?: string } {
  const messages = getProposeProjectMemoryPreviewMessages(locale);
  const index = PROJECT_MEMORY_TOPIC_ORDER.findIndex(topic => topic === params.topic);
  const total = PROJECT_MEMORY_TOPIC_ORDER.length;
  const summary = index < 0
    ? messages.summaryNoTopic
    : messages.summary(messages.topicNames[PROJECT_MEMORY_TOPIC_ORDER[index]], index + 1, total);
  if (!content) return { summary };
  if (content.length <= MEMORY_DRAFT_PREVIEW_CAP) return { summary, diff: content };
  const shown = cutAtBoundary(content, MEMORY_DRAFT_PREVIEW_CAP);
  return { summary, diff: `${shown}\n${messages.truncationNote(shown.length, content.length)}` };
}
