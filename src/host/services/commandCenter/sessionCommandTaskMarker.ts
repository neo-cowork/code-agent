import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getUserConfigDir } from '../../config/configPaths';
import { getBackgroundTaskLedger } from '../../task/backgroundTaskLedger';
import { createLogger } from '../infra/logger';

const logger = createLogger('SessionCommandTaskMarker');

export function sessionCommandMarkerDir(): string {
  return path.join(getUserConfigDir(), 'session-command-running');
}

export function sessionCommandMarkerPath(taskId: string): string {
  return path.join(sessionCommandMarkerDir(), `${encodeURIComponent(taskId)}.json`);
}

/** Restore the role by the original task and session identity. Initiating text is memory-only. */
export function recoverDelegatedUserRuleContext(sessionId: string, runId: string): { roleId?: string } | undefined {
  try {
    const task = getBackgroundTaskLedger().getTask(runId);
    if (task?.kind === 'session_command_task' && task.sessionId === sessionId && task.runId === runId) {
      const role = task.metadata?.permissionRoleId;
      return typeof role === 'string' ? { roleId: role } : {};
    }
    const marker = JSON.parse(readFileSync(sessionCommandMarkerPath(runId), 'utf8')) as { taskId?: unknown; sessionId?: unknown; permissionRoleId?: unknown };
    if (marker.taskId === runId && marker.sessionId === sessionId) {
      return typeof marker.permissionRoleId === 'string' ? { roleId: marker.permissionRoleId } : {};
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Delegated task permission context could not be restored', { runId, error: String(error) });
    }
  }
  return undefined;
}
