import {
  resolveBackgroundTaskName,
  getBackgroundTask,
  getAllBackgroundTasks,
  killBackgroundTask,
  onBackgroundTaskLifecycleEvent,
  type BackgroundTaskLifecycleEvent,
  type TaskInfo,
} from '../../shell/backgroundTasks';
import {
  getAllPtySessions,
  killPtySession,
  onPtySessionLifecycleEvent,
  type PtySessionInfo,
  type PtySessionLifecycleEvent,
} from '../../shell/ptyExecutor';

export {
  resolveBackgroundTaskName,
  getBackgroundTask,
  getAllBackgroundTasks,
  getAllPtySessions,
  killBackgroundTask,
  killPtySession,
  onBackgroundTaskLifecycleEvent,
  onPtySessionLifecycleEvent,
};

export type {
  BackgroundTaskLifecycleEvent,
  PtySessionInfo,
  PtySessionLifecycleEvent,
  TaskInfo,
};
