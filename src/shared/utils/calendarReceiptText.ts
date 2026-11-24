/** Removes the calendar write identifier from display text while preserving the model's output. */
export function stripCalendarReceiptUid(text: string): string {
  return text.replace(/^- uid:[^\r\n]*(?:\r?\n|$)|\r?\n- uid:[^\r\n]*/gi, '');
}
