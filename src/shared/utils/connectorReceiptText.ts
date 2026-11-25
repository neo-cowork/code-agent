/** Calendar list results keep the event identifier on its own indented line for the model. */
export function stripCalendarListUids(text: string): string {
  return text.replace(/\r?\n {2}uid:[^\r\n]*/gi, '');
}

/** Reminders use an identifier before the list name in model-facing rows. */
export function stripReminderRowIds(text: string): string {
  return text.replace(/^(- )#[^\r\n]+? (?=\[)/gm, '$1');
}
