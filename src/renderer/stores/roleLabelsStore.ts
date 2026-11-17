import { create } from 'zustand';
import { useAppStore } from './appStore';
import { languages } from '../i18n';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import { localizeBuiltinRole } from '@shared/localizeBuiltinRole';

export type RoleLabels = Readonly<Record<string, string>>;

// Presentation only: IDs in commands and persisted messages stay unchanged.
export const useRoleLabelsStore = create<{
  labels: { zh: RoleLabels; en: RoleLabels };
  setRoles: (roles: readonly RolePanelEntry[]) => void;
}>((set) => ({
  labels: { zh: {}, en: {} },
  setRoles: (roles) => {
    const forLanguage = (language: 'zh' | 'en'): RoleLabels => Object.fromEntries(roles.map((role) => {
      const localized = localizeBuiltinRole(role.roleId, { name: role.displayName?.trim() ?? '', profession: role.profession?.trim() }, language);
      const name = localized.name;
      const profession = localized.profession;
      const label = name && name !== role.roleId
        ? profession && profession !== name
          ? languages[language].roleEditReceipt.expertLabel.replace('{name}', () => name).replace('{profession}', () => profession)
          : name
        : role.roleId;
      return [role.roleId, label];
    }));
    set({ labels: { zh: forLanguage('zh'), en: forLanguage('en') } });
  },
}));

export function useRoleLabels(): RoleLabels {
  const language = useAppStore((state) => state.language);
  return useRoleLabelsStore((state) => state.labels[language]);
}
