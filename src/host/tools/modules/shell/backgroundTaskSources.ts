import {
  getAllBackgroundTasks,
  getTaskOutput,
  onBackgroundTaskLifecycleEvent,
  type BackgroundTaskLifecycleEvent,
  type BackgroundTaskLifecycleEventType,
  type TaskOutput,
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
  BackgroundTaskLifecycleEventType,
  PtySessionInfo,
  PtySessionLifecycleEvent,
  TaskInfo,
  TaskOutput,
};
