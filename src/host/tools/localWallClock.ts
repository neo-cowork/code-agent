/**
 * Parse a host-local wall-clock string "YYYY-MM-DD HH:mm" into a Unix-ms instant.
 * Returns undefined for bad format, calendar rollovers (e.g. 02-30) and
 * nonexistent spring-forward times; ambiguous fall-back times resolve to the
 * first occurrence, as the JS Date constructor does.
 */
export function parseHostLocalWallClock(local: unknown): number | undefined {
  if (typeof local !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(local);
  if (!match) return undefined;
  // ISO date-time without an offset is host-local. Round-trip every field to
  // reject calendar rollovers and nonexistent spring-forward wall-clock times.
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00`);
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
  if (parts.some((part, index) => part !== Number(match[index + 1]))) return undefined;
  return date.getTime();
}
