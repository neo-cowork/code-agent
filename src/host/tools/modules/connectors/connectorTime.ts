function readProcessTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function toDate(value: Date | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function formatParts(value: Date | number, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(toDate(value));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatUtcOffset(value: Date | number, timeZone: string): string {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
  }).formatToParts(toDate(value)).find((item) => item.type === 'timeZoneName');
  const offset = part?.value ?? 'GMT';
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(offset);
  if (!match) return 'UTC+0';
  return `UTC${match[1]}${match[2]}${match[3] ? `:${match[3]}` : ''}`;
}

export function formatConnectorTime(ms: number, timeZone = readProcessTimeZone()): string {
  const parts = formatParts(ms, timeZone);
  const offset = formatUtcOffset(ms, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${offset})`;
}

export function formatConnectorNow(
  now: Date | number = new Date(),
  timeZone = readProcessTimeZone(),
): string {
  return `现在：${formatConnectorTime(toDate(now).getTime(), timeZone)}；时区：${timeZone}。以下时间均按该时区显示。`;
}
