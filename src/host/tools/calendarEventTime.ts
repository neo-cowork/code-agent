import { parseHostLocalWallClock } from './localWallClock';

const CALENDAR_TIME_TOOLS = new Set(['calendar_create_event', 'calendar_update_event']);
const FIELDS = [
  { local: 'start_local', ms: 'start_ms' },
  { local: 'end_local', ms: 'end_ms' },
] as const;

/**
 * Convert start_local / end_local (host-local "YYYY-MM-DD HH:mm") to start_ms / end_ms
 * before approval and at direct module entry, then drop the local fields so a card edit
 * of the ms field stays authoritative. Same contract as normalizeReminderCreateTime.
 */
export function normalizeCalendarEventTime(
  toolName: string,
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; code: 'INVALID_ARGS'; error: string } {
  if (!CALENDAR_TIME_TOOLS.has(toolName)) return { ok: true, args };
  const next = { ...args };
  for (const { local, ms } of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(args, local)) continue;
    const instant = parseHostLocalWallClock(args[local]);
    if (instant === undefined) {
      return {
        ok: false,
        code: 'INVALID_ARGS',
        error: `${local} must be a valid existing host-local wall-clock time in YYYY-MM-DD HH:mm format, without a timezone suffix.`,
      };
    }
    if (args[ms] !== undefined) {
      return { ok: false, code: 'INVALID_ARGS', error: `Supply only one of ${local} and ${ms}.` };
    }
    delete next[local];
    next[ms] = instant;
  }
  return { ok: true, args: next };
}

/** Normalize list bounds before permission checks and connector dispatch. */
export function normalizeCalendarListWindow(
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; code: 'INVALID_ARGS'; error: string } {
  const next = { ...args };
  for (const [local, ms] of [['from_local', 'from_ms'], ['to_local', 'to_ms']] as const) {
    if (Object.prototype.hasOwnProperty.call(args, local)) {
      const instant = parseHostLocalWallClock(args[local]);
      if (instant === undefined) {
        return { ok: false, code: 'INVALID_ARGS', error: `${local} must be a real local time written as YYYY-MM-DD HH:mm, for example 2026-11-17 09:00.` };
      }
      delete next[local];
      next[ms] = instant;
    } else if (Object.prototype.hasOwnProperty.call(args, ms)
      && (typeof args[ms] !== 'number' || !Number.isFinite(args[ms]))) {
      return { ok: false, code: 'INVALID_ARGS', error: `${ms} must be a finite Unix-millisecond timestamp.` };
    }
  }
  const from = typeof next.from_ms === 'number' ? next.from_ms : new Date().setHours(0, 0, 0, 0);
  if (typeof next.to_ms === 'number') {
    if (next.to_ms < from) {
      return { ok: false, code: 'INVALID_ARGS', error: 'The to bound must not be earlier than the from bound.' };
    }
  } else if (typeof next.from_ms === 'number') {
    const fortnight = 14 * 24 * 60 * 60 * 1000;
    if (Date.now() + fortnight <= from) next.to_ms = from + fortnight;
  }
  return { ok: true, args: next };
}
