import {
  getAllBackgroundTasks,
  getBackgroundTask,
  resolveBackgroundTaskName,
} from '../../shell/backgroundTasks';

export { getAllBackgroundTasks, resolveBackgroundTaskName };

export function getBackgroundTaskPid(taskId: string): number | undefined {
  return getBackgroundTask(taskId)?.process.pid;
}
