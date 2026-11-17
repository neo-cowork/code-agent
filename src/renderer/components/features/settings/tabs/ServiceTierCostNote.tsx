// ServiceTierCostNote — 无人值守半价档的静态说明行（N-MODELCAT-SERVICE-TIER-COST）。
// 纯展示：无开关、无状态。倍率数字必须来自 SERVICE_TIER_COST_MULTIPLIER 常量，
// 文案（zhSettingsModels / enSettingsModels）只留 {multiplier} 占位符。
import React from 'react';
import {
  isServiceTierEligibleProvider,
  SERVICE_TIER_COST_MULTIPLIER,
  UNATTENDED_SERVICE_TIER,
} from '@shared/constants';
import { useI18n } from '../../../../hooks/useI18n';

export const ServiceTierCostNote: React.FC<{ provider: string }> = ({ provider }) => {
  const { t } = useI18n();
  if (!isServiceTierEligibleProvider(provider)) return null;
  const multiplier = SERVICE_TIER_COST_MULTIPLIER[UNATTENDED_SERVICE_TIER] ?? 1;
  return (
    <p className="text-xs text-zinc-500">
      {t.settings.model.serviceTierCostNote.replace('{multiplier}', String(multiplier))}
    </p>
  );
};
