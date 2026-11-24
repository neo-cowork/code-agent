import { containsCjk } from './containsCjk';
import type { Task } from './contract/backgroundTask';

export const BACKGROUND_COMMAND_TITLE: Readonly<Record<'zh' | 'en', string>> = {
  zh: '后台命令',
  en: 'Background command',
};

/** Choose a display title without changing the original task or notification payload. */
export function resolveBackgroundTaskTitle(
  task: { source?: Task['source']; title: string },
  language: 'zh' | 'en',
  fallback: string,
): string {
  const shell = task.source === 'shell' || task.source === 'pty';
  if (!shell && task.source !== 'delegate_task' && task.source !== 'session_command_center') return task.title;
  const hasCjk = containsCjk(task.title);
  const foreign = language === 'en' ? hasCjk : !hasCjk && /[A-Za-z]{2,}\s+[A-Za-z]/.test(task.title);
  return foreign || (shell && !task.title.trim()) ? fallback : task.title;
}
