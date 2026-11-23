import type { CreateCronJobDefinition, CronJobDefinition, CronJobExecution } from './contract/cron';
import { cronScheduleMinimumIntervalSeconds, everyScheduleIntervalSeconds } from './cronScheduleInterval';

const HOURS_PER_DAY = 24;
const SECONDS_PER_DAY = HOURS_PER_DAY * 60 * 60;

type ScheduleRunCost =
  | { kind: 'none' | 'unknown' | 'flat-fee' }
  | { kind: 'usd'; perRunUsd: number; perDayUsd: number };

function estimateCost(executions: readonly CronJobExecution[], runsPerDay: number): ScheduleRunCost {
  const localModelRuns = executions.filter((run) => run.runsOn !== 'cloud' && run.sessionId);
  const costs = localModelRuns
    .flatMap(({ cost }) => cost !== undefined && Number.isFinite(cost) && cost > 0 ? [cost] : [])
    .sort((a, b) => a - b);
  if (!costs.length) {
    return localModelRuns.some((run) => run.flatFee) ? { kind: 'flat-fee' } : { kind: 'unknown' };
  }
  const middle = Math.floor(costs.length / 2);
  const perRunUsd = costs.length % 2 === 0
    ? (costs[middle - 1] + costs[middle]) / 2
    : costs[middle];
  return { kind: 'usd', perRunUsd, perDayUsd: perRunUsd * runsPerDay };
}

export function estimateScheduleRuns(
  schedule: CronJobDefinition['schedule'],
  runsOn: CreateCronJobDefinition['runsOn'],
  actionType: CronJobDefinition['action']['type'],
  executions: readonly CronJobExecution[],
): { runsPerDay: number; exact: boolean; highlight: boolean; cost: ScheduleRunCost } | undefined {
  if (schedule.type !== 'every' && schedule.type !== 'cron') return undefined;

  let seconds: number | undefined;
  try {
    seconds = everyScheduleIntervalSeconds(schedule) ?? cronScheduleMinimumIntervalSeconds(schedule);
  } catch {
    // Invalid drafts can reach the preview before save-time validation.
    return undefined;
  }
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;

  const exact = schedule.type === 'every';
  const roundedRuns = Math.round(SECONDS_PER_DAY / seconds);
  const runsPerDay = exact ? roundedRuns : Math.max(1, roundedRuns);
  const local = runsOn !== 'cloud';
  return {
    runsPerDay,
    exact,
    highlight: local && runsPerDay > HOURS_PER_DAY,
    cost: local && (actionType === 'agent' || actionType === 'role-wake')
      ? estimateCost(executions, runsPerDay)
      : { kind: 'none' },
  };
}
