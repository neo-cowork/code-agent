import type { AgentTreeNode } from '@shared/contract/agentTree';
import { languages, type Translations } from '../i18n';
import { useAppStore } from '../stores/appStore';

/** Resolve at render time so persisted sessions keep their original role ids. */
export function agentRoleLabel(
  role: string,
  labels: Translations['agentRoleLabels'] = languages[useAppStore.getState().language].agentRoleLabels,
): string {
  const name = role.trim();
  if (Object.hasOwn(labels.roles, name)) return labels.roles[name as keyof typeof labels.roles];
  if (/\p{Script=Han}/u.test(name)) return name;
  return labels.assistant;
}

/** Background names are host/model bookkeeping; retain the existing Chinese display. */
export function agentNodeLabel(
  node: Pick<AgentTreeNode, 'role' | 'displayName' | 'background'>,
  labels: Translations['agentRoleLabels'] = languages[useAppStore.getState().language].agentRoleLabels,
): string {
  return node.background && labels === languages.en.agentRoleLabels
    ? labels.roles.background
    : agentRoleLabel(node.displayName || node.role, labels);
}
