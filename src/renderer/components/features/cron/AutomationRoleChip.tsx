import React, { useEffect, useState } from 'react';
import { localizeBuiltinRole } from '@shared/localizeBuiltinRole';
import { listRoles } from '../../../services/rolesClient';
import { useI18n } from '../../../hooks/useI18n';
import { Badge } from '../../primitives/Badge';

/** 待过目卡片上的专家名：角色已删回落原始 id；没有绑定专家（roleId 为空）不渲染。 */
export const AutomationRoleChip: React.FC<{ roleId?: string }> = ({ roleId }) => {
  const { language } = useI18n();
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!roleId) return undefined;
    let alive = true;
    listRoles()
      .then((roles) => {
        if (!alive) return;
        const displayName = roles.find((role) => role.roleId === roleId)?.displayName;
        setName(displayName ? localizeBuiltinRole(roleId, { name: displayName }, language).name : null);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [roleId, language]);
  if (!roleId) return null;
  return (
    <Badge className="border-zinc-700 bg-zinc-800/60 text-[10px] text-zinc-300" data-testid="automation-review-role-chip">
      {name || roleId}
    </Badge>
  );
};
