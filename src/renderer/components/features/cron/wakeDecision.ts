import type { CronJobExecution } from '@shared/contract';

export type WakeDecisionKey = 'advance' | 'report' | 'suggest' | 'silence';

const DECISIONS: readonly string[] = ['advance', 'report', 'suggest', 'silence'];

/** 执行记录 result 是已完成的角色唤醒时，返回四选一决策；其它形状返回 null。 */
export function wakeDecisionOf(execution: Pick<CronJobExecution, 'result'>): WakeDecisionKey | null {
  const result = execution.result;
  if (typeof result !== 'object' || result === null) return null;
  const record = result as Record<string, unknown>;
  if (record.status !== 'completed' || typeof record.roleId !== 'string') return null;
  return typeof record.decision === 'string' && DECISIONS.includes(record.decision)
    ? record.decision as WakeDecisionKey
    : null;
}
