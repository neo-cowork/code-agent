/** The identifier is the last header line, before the time fields in create and update receipts. */
export function stripCalendarReceiptUid(text: string): string {
  const timeFields = text.search(/\r?\n- (?:Start:|开始：)[^\r\n]*\r?\n- (?:End:|结束：)/);
  const headerEnd = timeFields === -1 ? text.length : timeFields;
  const header = text.slice(0, headerEnd).replace(/\r?\n- uid:[^\r\n]*$/i, '');
  return header + text.slice(headerEnd);
}
