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
