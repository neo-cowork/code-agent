import { useEffect, useState } from 'react';
import type { CreateCronJobDefinition, CronJobExecution } from '@shared/contract/cron';
import { cronClient } from '../../../services/cronClient';

export function useScheduleEstimateHistory(
  job: Pick<CreateCronJobDefinition, 'action' | 'schedule' | 'runsOn'>,
): readonly CronJobExecution[] {
  const [history, setHistory] = useState<readonly CronJobExecution[]>([]);
  const shouldFetch = job.runsOn !== 'cloud'
    && (job.schedule?.type === 'every' || job.schedule?.type === 'cron')
    && (job.action?.type === 'agent' || job.action?.type === 'role-wake');
  useEffect(() => {
    if (!shouldFetch) return;
    let active = true;
    async function load() {
      try {
        const executions = await cronClient.getRecentExecutions();
        if (active) setHistory(executions ?? []);
      } catch {
        if (active) setHistory([]);
      }
    }
    void load();
    return () => { active = false; };
  }, [shouldFetch]);

  return history;
}
