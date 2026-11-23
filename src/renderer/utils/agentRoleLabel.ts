import type { Task } from '@shared/contract/backgroundTask';
import { containsCjk } from './containsCjk';
import type { AgentTreeNode } from '@shared/contract/agentTree';
import { languages, type Translations } from '../i18n';
import { useAppStore } from '../stores/appStore';
import { localizeBuiltinRole } from '@shared/localizeBuiltinRole';

/** Resolve at render time so persisted sessions keep their original role ids. */
export function agentRoleLabel(
  role: string,
  labels: Translations['agentRoleLabels'] = (languages[useAppStore.getState().language] ?? languages.zh).agentRoleLabels,
): string {
  const name = role.trim();
  if (Object.hasOwn(labels.roles, name)) return labels.roles[name as keyof typeof labels.roles];
  if (/\p{Script=Han}/u.test(name)) return localizeBuiltinRole(name, { name }, labels === languages.en.agentRoleLabels ? 'en' : 'zh').name;
  return labels.assistant;
}

/** Background names are host/model bookkeeping; retain the existing Chinese display. */
export function agentNodeLabel(
  node: Pick<AgentTreeNode, 'role' | 'displayName' | 'background'>,
  labels: Translations['agentRoleLabels'] = (languages[useAppStore.getState().language] ?? languages.zh).agentRoleLabels,
): string {
  return node.background && labels === languages.en.agentRoleLabels
    ? labels.roles.background
    : agentRoleLabel(node.displayName || node.role, labels);
}

/** Model-generated background titles may be in the other language than the UI. */
export function backgroundTaskLabel(task: { source?: Task['source']; title: string }, t: Translations): string {
  if (task.source !== 'delegate_task' && task.source !== 'session_command_center') return task.title;
  const foreign = t === languages.en
    ? containsCjk(task.title)
    : t === languages.zh && !containsCjk(task.title) && /[A-Za-z]{2,}\s+[A-Za-z]/.test(task.title);
  return foreign ? t.agentRoleLabels.roles.background : task.title;
}

/**
 * 同一会话里多个后台任务都折叠成同一个兜底名时编号（助手 1 / 助手 2）。
 * 序号按「该会话账本全集」的 createdAt、id 排序，不依赖调用方各自筛过的子集，
 * 这样任务栏、成员列表、回放摘要里同一个任务永远是同一个名字。
 */
export function backgroundTaskLabels(
  tasks: Array<Pick<Task, 'id' | 'sessionId' | 'source' | 'title' | 'createdAt'>>,
  t: Translations,
): Map<string, string> {
  const labels = new Map(tasks.map((task) => [task.id, backgroundTaskLabel(task, t)] as const));
  const fallback = t.agentRoleLabels.roles.background;
  const folded = new Map<string, typeof tasks>();
  for (const task of tasks) {
    if (labels.get(task.id) !== fallback) continue;
    const key = task.sessionId ?? '';
    folded.set(key, [...(folded.get(key) ?? []), task]);
  }
  for (const group of folded.values()) {
    if (group.length < 2) continue;
    [...group]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .forEach((task, index) => labels.set(task.id, `${fallback} ${index + 1}`));
  }
  return labels;
}
