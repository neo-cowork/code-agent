import {
  getAllBackgroundTasks,
  getTaskOutput,
  onBackgroundTaskLifecycleEvent,
  type BackgroundTaskLifecycleEvent,
  type TaskInfo,
} from '../../shell/backgroundTasks';
import {
  getAllPtySessions,
  getPtySessionOutput,
  onPtySessionLifecycleEvent,
  type PtySessionInfo,
  type PtySessionLifecycleEvent,
} from '../../shell/ptyExecutor';

export {
  getAllBackgroundTasks,
  getTaskOutput,
  getAllPtySessions,
  getPtySessionOutput,
  onBackgroundTaskLifecycleEvent,
  onPtySessionLifecycleEvent,
};

export type {
  BackgroundTaskLifecycleEvent,
  PtySessionInfo,
  PtySessionLifecycleEvent,
  TaskInfo,
};
