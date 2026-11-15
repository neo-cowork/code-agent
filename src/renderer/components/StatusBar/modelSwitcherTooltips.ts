import type { ModelProvider } from '@shared/contract';
import { languages, type Language } from '../../i18n';
import type { EffortOption, ProviderBillingSummary, ProviderHealthSummary } from './modelSwitcherHelpers';

export function formatNativeModelSwitcherTooltip(args: {
  language?: Language;
  engineLabel: string;
  currentModel: string;
  displayProvider: ModelProvider;
  displayModel: string;
  adaptive: boolean;
  overridden: boolean;
  billingSummary?: ProviderBillingSummary | null;
  healthSummary?: ProviderHealthSummary | null;
  effort?: Pick<EffortOption, 'label' | 'shortLabel'> | null;
  thinkingLabel?: string | null;
  thinkingEnabled?: boolean | null;
}): string {
  const language = args.language ?? 'zh';
  const labels = languages[language].modelSwitcherTooltip;
  const modelLine = args.adaptive
    ? labels.adaptive.replace('{model}', args.currentModel)
    : args.overridden
      ? labels.overridden.replace('{model}', `${args.displayProvider}/${args.displayModel}`).replace('{original}', args.currentModel)
      : labels.model.replace('{model}', `${args.displayProvider}/${args.displayModel}`);
  return [
    modelLine,
    args.billingSummary ? labels.billing.replace('{billing}', languages[language].settings.model.models.switcherTooltip.billingModes[args.billingSummary.mode]) : null,
    args.healthSummary && args.healthSummary.state !== 'unknown'
      ? `${labels.service}: ${languages[language].settings.model.models.switcherTooltip.health[args.healthSummary.state]}` : null,
    args.effort ? `${labels.effort}: ${language === 'zh' ? args.effort.shortLabel : args.effort.label}` : null,
    typeof args.thinkingEnabled === 'boolean'
      ? `${labels.thinking}: ${args.thinkingEnabled ? languages[language].settings.model.models.switcherTooltip.thinkingOn : languages[language].settings.model.models.switcherTooltip.thinkingOff}`
      : args.thinkingLabel ? `${labels.thinking}: ${args.thinkingLabel}` : null,
  ].filter(Boolean).join(' · ');
}

export function formatExternalModelSwitcherTooltip(args: {
  language?: Language;
  engineLabel: string;
  model?: string | null;
  effort?: Pick<EffortOption, 'label' | 'shortLabel'> | null;
  reliabilityLabel?: string | null;
}): string {
  const language = args.language ?? 'zh';
  const labels = languages[language].modelSwitcherTooltip;
  return [
    `${labels.engine}: ${args.engineLabel}`,
    labels.model.replace('{model}', args.model ?? languages[language].settings.model.models.switcherTooltip.defaultModel),
    args.effort ? `${labels.effort}: ${language === 'zh' ? args.effort.shortLabel : args.effort.label}` : null,
    args.reliabilityLabel ? `${labels.service}: ${args.reliabilityLabel}` : null,
  ].filter(Boolean).join(' · ');
}
