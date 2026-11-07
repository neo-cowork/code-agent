import {
  getBackgroundTask,
  getAllBackgroundTasks,
  killBackgroundTask,
  onBackgroundTaskLifecycleEvent,
  type BackgroundTaskLifecycleEvent,
  type TaskInfo,
} from '../../shell/backgroundTasks';
import {
  getAllPtySessions,
  onPtySessionLifecycleEvent,
  type PtySessionInfo,
  type PtySessionLifecycleEvent,
} from '../../shell/ptyExecutor';

export {
  getBackgroundTask,
  getAllBackgroundTasks,
  getAllPtySessions,
  killBackgroundTask,
  onBackgroundTaskLifecycleEvent,
  onPtySessionLifecycleEvent,
};

export type {
  BackgroundTaskLifecycleEvent,
  PtySessionInfo,
  PtySessionLifecycleEvent,
  TaskInfo,
};
