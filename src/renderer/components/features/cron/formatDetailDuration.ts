type DetailDurationUnits = Record<'seconds' | 'minutes' | 'hours', { one: string; other: string }>;

export function formatDetailDuration(milliseconds: number | null | undefined, units: DetailDurationUnits): string {
  if (milliseconds == null) return '—';
  const unit = milliseconds !== 0 && milliseconds % 3_600_000 === 0
    ? 'hours'
    : milliseconds !== 0 && milliseconds % 60_000 === 0 ? 'minutes' : 'seconds';
  const size = { hours: 3_600_000, minutes: 60_000, seconds: 1_000 }[unit];
  const value = Number((milliseconds / size).toFixed(3));
  return `${value} ${units[unit][value === 1 ? 'one' : 'other']}`;
}
