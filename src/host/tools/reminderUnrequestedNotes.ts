// Blank notes, and notes that only restate the title, are not a reminder body.
// A single leading label (提醒 / Reminder / Remind) does not make a restatement
// into new text: "提醒：买菜" is still the title "买菜".

const LEADING_NOTE_LABEL = /^(?:提醒|reminder|remind)/u;

function foldReminderText(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}]+/gu, '');
}

export type UnrequestedReminderNotesReason = 'empty' | 'restates-title';

function withoutNotes(
  args: Record<string, unknown>,
  reason: UnrequestedReminderNotesReason,
): { args: Record<string, unknown>; dropped: true; reason: UnrequestedReminderNotesReason } {
  const { notes: _notes, ...rest } = args;
  return { args: rest, dropped: true, reason };
}

/** Drop notes before approval when they are blank or only restate the title. */
export function omitUnrequestedReminderNotes(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  dropped: boolean;
  reason?: UnrequestedReminderNotesReason;
} {
  if (typeof args.notes !== 'string') return { args, dropped: false };
  if (args.notes.trim() === '') return withoutNotes(args, 'empty');
  const title = typeof args.title === 'string' ? args.title : '';
  const foldedNotes = foldReminderText(args.notes);
  const foldedTitle = foldReminderText(title);
  const unlabeled = foldedNotes.replace(LEADING_NOTE_LABEL, '');
  const restatesTitle = foldedNotes === foldedTitle
    || (unlabeled !== foldedNotes && unlabeled === foldedTitle);
  if (!restatesTitle) return { args, dropped: false };
  return withoutNotes(args, 'restates-title');
}
