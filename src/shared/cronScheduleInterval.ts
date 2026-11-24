import { Cron } from 'croner';
import type { CronJobDefinition } from './contract/cron';

export function everyScheduleIntervalSeconds(schedule: CronJobDefinition['schedule']): number | undefined {
  if (schedule.type !== 'every') return undefined;
  const multiplier = {
    seconds: 1,
    minutes: 60,
    hours: 60 * 60,
    days: 24 * 60 * 60,
  }[schedule.unit];
  return schedule.interval * multiplier;
}

export function cronScheduleIntervalRangeSeconds(
  schedule: CronJobDefinition['schedule'],
): { min: number; max: number } | undefined {
  if (schedule.type !== 'cron') return undefined;
  const probe = new Cron(schedule.expression, { timezone: schedule.timezone, paused: true });
  try {
    const runs = probe.nextRuns(16);
    if (runs.length < 2) return undefined;
    let min = Infinity;
    let max = 0;
    for (let index = 1; index < runs.length; index++) {
      const gap = (runs[index].getTime() - runs[index - 1].getTime()) / 1000;
      min = Math.min(min, gap);
      max = Math.max(max, gap);
    }
    return { min, max };
  } finally {
    probe.stop();
  }
}

export function cronScheduleMinimumIntervalSeconds(schedule: CronJobDefinition['schedule']): number | undefined {
  return cronScheduleIntervalRangeSeconds(schedule)?.min;
}
