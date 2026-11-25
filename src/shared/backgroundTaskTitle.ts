import { containsCjk } from './containsCjk';
import type { Task } from './contract/backgroundTask';

export const BACKGROUND_COMMAND_TITLE: Readonly<Record<'zh' | 'en', string>> = {
  zh: '后台命令',
  en: 'Background command',
};

const FILE_ACTION_TITLE = {
  zh: { cp: '复制', mv: '移动', to: '到' },
  en: { cp: 'Copy', mv: 'Move', to: 'to' },
};

export function formatBackgroundFileActionTitle(
  action: 'cp' | 'mv', source: string, destination: string, language: 'zh' | 'en', maxLength: number,
): string {
  const words = FILE_ACTION_TITLE[language];
  const prefix = `${words[action]} `;
  const connector = ` ${words.to} `;
  const basenameBudget = maxLength - prefix.length - connector.length;
  const sourceBudget = Math.max(Math.floor(basenameBudget / 2), basenameBudget - destination.length);
  const shortSource = source.slice(0, sourceBudget);
  const shortDestination = destination.slice(0, basenameBudget - shortSource.length);
  return `${prefix}${shortSource}${connector}${shortDestination}`;
}

export function isEnglishBackgroundFileActionTitle(title: string): boolean {
  return /^(?:Copy|Move) [^\r\n]+ to [^\r\n]+$/.test(title);
}

export function isForeignBackgroundTaskTitle(title: string, language: 'zh' | 'en'): boolean {
  const hasCjk = containsCjk(title);
  // English file-action titles may include CJK basenames.
  return language === 'en'
    ? hasCjk && !isEnglishBackgroundFileActionTitle(title)
    : !hasCjk && /[A-Za-z]{2,}\s+[A-Za-z]/.test(title);
}

/** Choose a display title without changing the original task or notification payload. */
export function resolveBackgroundTaskTitle(
  task: { source?: Task['source']; title: string },
  language: 'zh' | 'en',
  fallback: string,
): string {
  const shell = task.source === 'shell' || task.source === 'pty';
  if (!shell && task.source !== 'delegate_task' && task.source !== 'session_command_center') return task.title;
  return isForeignBackgroundTaskTitle(task.title, language) || (shell && !task.title.trim()) ? fallback : task.title;
}
