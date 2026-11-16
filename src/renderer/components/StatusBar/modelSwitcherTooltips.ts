import type { AppSettings, ModelProvider } from '@shared/contract';
import { getRuntimeModelLabel, type RuntimeModelOption } from '@shared/modelRuntime';
import { getProviderDisplayName } from '@shared/constants';
import { resolveProviderLabel } from '../../i18n/providerDisplay';
import { languages, type Language } from '../../i18n';
import type { EffortOption, ProviderBillingSummary, ProviderHealthSummary } from './modelSwitcherHelpers';

function providerName(provider: string, settings: AppSettings | null | undefined, language: Language): string {
  return resolveProviderLabel(provider,
    settings?.models?.providers?.[provider as ModelProvider]?.displayName
      || getProviderDisplayName(provider) || getProviderDisplayName('custom'), language);
}

export function formatModelSwitcherLabel(
  model: string, provider: ModelProvider, settings: AppSettings | null,
  options: RuntimeModelOption[], language: Language,
): string {
  const label = getRuntimeModelLabel(model, provider, settings);
  if (!options.some((option) => option.model === model && option.provider !== provider)) return label;
  const selected = options.find((option) => option.model === model && option.provider === provider);
  const sourceLabel = selected?.providerSourceLabel || settings?.models?.providers?.[provider]?.displayName || selected?.providerLabel;
  return `${label} · ${sourceLabel ? resolveProviderLabel(provider, sourceLabel, language) : providerName(provider, settings, language)}`;
}

export function formatNativeModelSwitcherTooltip(args: {
  language?: Language;
  engineLabel: string;
  settings?: AppSettings | null;
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
  /** host 这一轮把模型换掉了（路由/回落）：显示真正在用的那个，并说清从哪个换来 */
  switchedFrom?: { provider: string; model: string; reason: string } | null;
  shownProvider?: string;
  shownModel?: string;
}): string {
  const language = args.language ?? 'zh';
  const labels = languages[language].modelSwitcherTooltip;
  const identity = (provider: string, model: string) => `${providerName(provider, args.settings, language)}/${model}`;
  const modelLine = args.switchedFrom
    ? labels.switched
        .replace('{shown}', identity(args.shownProvider ?? args.displayProvider, args.shownModel ?? args.displayModel))
        .replace('{original}', identity(args.switchedFrom.provider, args.switchedFrom.model))
    : args.adaptive
      ? labels.adaptive.replace('{model}', args.currentModel)
      : args.overridden
        ? labels.overridden.replace('{model}', identity(args.displayProvider, args.displayModel)).replace('{original}', args.currentModel)
        : labels.model.replace('{model}', identity(args.displayProvider, args.displayModel));
  return [
    modelLine,
    args.billingSummary ? labels.billing.replace('{billing}', languages[language].settings.model.models.switcherPanel.billing[args.billingSummary.mode]) : null,
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
