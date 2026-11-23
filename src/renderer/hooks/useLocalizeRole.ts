import { useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import { localizeBuiltinRole, type RoleNameParts } from '@shared/localizeBuiltinRole';

/** Render-time only: the result must never be sent, stored, compared or put into an @/slash token. */
export function useLocalizeRole(): (roleId: string, parts: RoleNameParts) => RoleNameParts {
  const language = useAppStore((state) => state.language);
  return useCallback((roleId, parts) => localizeBuiltinRole(roleId, parts, language), [language]);
}
