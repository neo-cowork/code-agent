import type { chatInputZh } from '../../../../i18n/chatInput';

type ChatInputCopy = (typeof chatInputZh)['chatInput'];

export function pdfPageSentence(
  copy: ChatInputCopy,
  pageCount: number | undefined,
): string | undefined {
  if (pageCount == null || pageCount < 1) return undefined;
  if (pageCount === 1) return copy.attachPdfOnePage;
  return copy.attachPdfPages.replace('{count}', String(pageCount));
}
