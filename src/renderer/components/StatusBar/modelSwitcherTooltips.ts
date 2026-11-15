import type { ModelProvider } from '@shared/contract';
import { languages, type Language } from '../../i18n';
import { interpolate } from '../../i18n/interpolate';
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
  /** host 这一轮把模型换掉了（路由/回落）：显示真正在用的那个，并说清从哪个换来 */
  switchedFrom?: { provider: string; model: string; reason: string } | null;
  shownProvider?: string;
  shownModel?: string;
}): string {
  const language = args.language ?? 'zh';
  const labels = languages[language].modelSwitcherTooltip;
  const copy = languages[language].modelSwitcherCopy;
  const modelLine = args.switchedFrom
    ? interpolate(copy.tooltipSwitched, {
      shown: `${args.shownProvider}/${args.shownModel}`,
      chosen: `${args.switchedFrom.provider}/${args.switchedFrom.model}`,
    })
    : args.adaptive
    ? interpolate(copy.tooltipAdaptive, { current: args.currentModel })
    : args.overridden
      ? interpolate(copy.tooltipOverridden, { model: `${args.displayProvider}/${args.displayModel}`, current: args.currentModel })
      : interpolate(copy.tooltipMainModel, { model: `${args.displayProvider}/${args.displayModel}` });
  return [
    modelLine,
    args.billingSummary ? interpolate(copy.tooltipBilling, { label: args.billingSummary.label }) : null,
    args.healthSummary && args.healthSummary.state !== 'unknown'
      ? `${labels.service}: ${args.healthSummary.label}` : null,
    args.effort ? `${labels.effort}: ${language === 'zh' ? args.effort.shortLabel : args.effort.label}` : null,
    args.thinkingLabel ? `${labels.thinking}: ${args.thinkingLabel}` : null,
  ].filter(Boolean).join(' · ');
}

export function formatExternalModelSwitcherTooltip(args: {
  language?: Language;
  engineLabel: string;
  model: string;
  effort?: Pick<EffortOption, 'label' | 'shortLabel'> | null;
  reliabilityLabel?: string | null;
}): string {
  const language = args.language ?? 'zh';
  const labels = languages[language].modelSwitcherTooltip;
  const copy = languages[language].modelSwitcherCopy;
  return [
    `${labels.engine}: ${args.engineLabel}`,
    interpolate(copy.tooltipMainModel, { model: args.model }),
    args.effort ? `${labels.effort}: ${language === 'zh' ? args.effort.shortLabel : args.effort.label}` : null,
    args.reliabilityLabel ? `${labels.service}: ${args.reliabilityLabel}` : null,
  ].filter(Boolean).join(' · ');
}
