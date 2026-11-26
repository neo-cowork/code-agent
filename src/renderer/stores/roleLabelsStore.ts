import { create } from 'zustand';
import { useAppStore } from './appStore';
import { languages } from '../i18n';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import { localizeBuiltinRole } from '@shared/localizeBuiltinRole';

export type RoleLabels = Readonly<Record<string, string>>;

function buildRoleLabel(
  role: Pick<RolePanelEntry, 'roleId' | 'displayName' | 'profession'>,
  language: 'zh' | 'en',
): string {
  const localized = localizeBuiltinRole(
    role.roleId,
    { name: role.displayName?.trim() ?? '', profession: role.profession?.trim() },
    language,
  );
  const name = localized.name;
  const profession = localized.profession;
  return name && name !== role.roleId
    ? profession && profession !== name
      ? languages[language].roleEditReceipt.expertLabel.replace('{name}', () => name).replace('{profession}', () => profession)
      : name
    : role.roleId;
}

// Presentation only: IDs in commands and persisted messages stay unchanged.
export const useRoleLabelsStore = create<{
  labels: { zh: RoleLabels; en: RoleLabels };
  setRoles: (roles: readonly RolePanelEntry[]) => void;
  setRoleLabel: (role: Pick<RolePanelEntry, 'roleId' | 'displayName' | 'profession'>) => void;
}>((set) => ({
  labels: { zh: {}, en: {} },
  setRoles: (roles) => {
    const forLanguage = (language: 'zh' | 'en'): RoleLabels => Object.fromEntries(
      roles.map((role) => [role.roleId, buildRoleLabel(role, language)]),
    );
    set({ labels: { zh: forLanguage('zh'), en: forLanguage('en') } });
  },
  setRoleLabel: (role) => {
    set((state) => ({
      labels: {
        zh: { ...state.labels.zh, [role.roleId]: buildRoleLabel(role, 'zh') },
        en: { ...state.labels.en, [role.roleId]: buildRoleLabel(role, 'en') },
      },
    }));
  },
}));

export function resolveRoleLabel(
  roleId: string,
  language: 'zh' | 'en',
  labels: RoleLabels = useRoleLabelsStore.getState().labels[language],
): string {
  const trimmed = roleId.trim();
  if (!trimmed) return '';
  if (Object.hasOwn(labels, trimmed) && labels[trimmed]) {
    return labels[trimmed];
  }
  return localizeBuiltinRole(trimmed, { name: trimmed }, language).name;
}

export function useRoleLabels(): RoleLabels {
  const language = useAppStore((state) => state.language);
  return useRoleLabelsStore((state) => state.labels[language]);
}
