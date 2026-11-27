import { lstatSync } from 'node:fs';
import { BACKGROUND_TASK_MAX_LEFTOVER_PATHS } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ApprovedRmSettlementTargets');
const targetsBySession = new Map<string, Map<string | undefined, Set<string>>>();

export function recordApprovedRmSettlementTargets(
  sessionId: string | undefined,
  runId: string | undefined,
  paths: readonly string[],
  source: 'approval' | 'unfinished_rm' = 'approval',
): void {
  if (!sessionId || paths.length === 0) return;
  const runs = targetsBySession.get(sessionId) ?? new Map<string | undefined, Set<string>>();
  const targets = runs.get(runId) ?? new Set<string>();
  const otherRunTargetCount = [...runs.values()].reduce((total, runTargets) => total + runTargets.size, 0) - targets.size;
  for (const path of paths) {
    if (otherRunTargetCount + targets.size >= BACKGROUND_TASK_MAX_LEFTOVER_PATHS) break;
    try {
      if (lstatSync(path, { throwIfNoEntry: false })?.isFile()) targets.add(path);
    } catch {
      // Only track files whose presence at approval time is known.
    }
  }
  if (targets.size === 0) return;
  runs.set(runId, targets);
  targetsBySession.set(sessionId, runs);
  logger.info('Approved rm settlement targets recorded', { sessionId, runId, targetCount: targets.size, source });
}

export function hasApprovedRmSettlementTargets(sessionId: string, runId?: string): boolean {
  return targetsBySession.get(sessionId)?.has(runId) ?? false;
}

/** Consume a single run's record. An inaccessible path cannot confirm the file is gone. */
export function takeApprovedRmLeftovers(
  sessionId: string,
  runId: string | undefined,
  entry: 'web' | 'desktop' | 'delegated',
  check: boolean,
): string[] {
  const runs = targetsBySession.get(sessionId);
  const targets = runs?.get(runId);
  if (!targets) return [];
  runs?.delete(runId);
  if (!runs?.size) targetsBySession.delete(sessionId);
  const leftovers = check ? [...targets].filter((path) => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code !== 'ENOENT' && code !== 'ENOTDIR';
    }
  }) : [];
  logger.info('Approved rm settlement targets consumed', { sessionId, runId, entry, checked: check, leftoverCount: leftovers.length });
  return leftovers;
}
