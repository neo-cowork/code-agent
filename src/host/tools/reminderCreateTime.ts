/** Normalize reminder wall-clock input before approval, and at direct module entry. */
export function normalizeReminderCreateTime(
  toolName: string,
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; code: 'INVALID_ARGS'; error: string } {
  if (toolName !== 'reminders_create' || !Object.prototype.hasOwnProperty.call(args, 'remind_at_local')) {
    return { ok: true, args };
  }
  const invalid = {
    ok: false as const,
    code: 'INVALID_ARGS' as const,
    error: 'remind_at_local must be a valid existing host-local wall-clock time in YYYY-MM-DD HH:mm format, without a timezone suffix.',
  };
  const local = args.remind_at_local;
  if (typeof local !== 'string') return invalid;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(local);
  if (!match) return invalid;
  // ISO date-time without an offset is host-local. Round-trip every field to
  // reject calendar rollovers and nonexistent spring-forward wall-clock times.
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00`);
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
  if (parts.some((part, index) => part !== Number(match[index + 1]))) return invalid;
  if (args.remind_at_ms !== undefined) {
    return { ok: false, code: 'INVALID_ARGS', error: 'Supply only one of remind_at_local and remind_at_ms.' };
  }
  // Remove the wall-clock field: approval edits to remind_at_ms are authoritative
  // and must not be overwritten by a second normalization during dispatch.
  const { remind_at_local: _local, ...rest } = args;
  return { ok: true, args: { ...rest, remind_at_ms: date.getTime() } };
}
