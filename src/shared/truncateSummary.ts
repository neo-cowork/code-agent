/** Keep bounded previews readable; the caller retains the original for expansion. */
export function truncateSummaryAtBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const prefix = text.slice(0, cap - 1);
  // Ignore distant boundaries: a heading must not consume the entire preview.
  const minimumBoundary = Math.floor(prefix.length / 2);
  const sentences = [...prefix.matchAll(/[。！？.!?\n]/g)].filter((match) => match.index >= minimumBoundary);
  const sentenceEnd = sentences.at(-1)?.index;
  const whitespace = [...prefix.matchAll(/\s/g)].filter((match) => match.index >= minimumBoundary).at(-1)?.index;
  const end = sentenceEnd !== undefined ? sentenceEnd + 1 : whitespace;
  // Unbroken tokens have no word boundary. Preserve the cap and mark omission,
  // without leaving half of a UTF-16 surrogate pair in the preview.
  return `${prefix.slice(0, end).trimEnd().replace(/[\uD800-\uDBFF]$/, '')}…`;
}
