/** A reminder time may be at most this far in the past before it is rejected. */
export const REMINDER_PAST_GRACE_MS = 60_000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function rejectIfPast(args: Record<string, unknown>): { ok: false; code: 'REMINDER_TIME_IN_PAST'; error: string } | null {
  const ms = args.remind_at_ms;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const nowMs = Date.now();
  if (ms >= nowMs - REMINDER_PAST_GRACE_MS) return null;
  const now = new Date(nowMs);
  const tomorrow = new Date(ms);
  tomorrow.setFullYear(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    ok: false,
    code: 'REMINDER_TIME_IN_PAST',
    error: `The requested reminder time ${formatLocal(new Date(ms))} has already passed (current local time: ${formatLocal(now)}, time zone ${zone}). `
      + 'Do not create this reminder. Ask the user whether they mean the same time tomorrow '
      + `(${formatLocal(tomorrow)}) or a different time, and only create it after they answer.`,
  };
}

/** Normalize reminder wall-clock input before approval, and at direct module entry. */
export function normalizeReminderCreateTime(
  toolName: string,
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; code: 'INVALID_ARGS' | 'REMINDER_TIME_IN_PAST'; error: string } {
  if (toolName !== 'reminders_create') return { ok: true, args };
  if (!Object.prototype.hasOwnProperty.call(args, 'remind_at_local')) {
    return rejectIfPast(args) ?? { ok: true, args };
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
  const normalized = { ...rest, remind_at_ms: date.getTime() };
  return rejectIfPast(normalized) ?? { ok: true, args: normalized };
}
