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
