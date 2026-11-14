import type { ModelProvider } from '@shared/contract';
import type { EffortLevel } from '../../../shared/contract/agent';
import { languages, type Language, type Translations } from '../../i18n';
import { interpolate } from '../../i18n/interpolate';
import type { EffortOption, ProviderBillingSummary, ProviderHealthSummary } from './modelSwitcherHelpers';

export type ModelSwitcherTooltipLabels = Translations['settings']['model']['models']['switcherTooltip'];

type TooltipEffort = Pick<EffortOption, 'label' | 'shortLabel'> & { value?: EffortLevel };

/**
 * Passing `labels` (the current UI language's `settings.model.models.switcherTooltip`) selects the fully
 * localized wording used by the status bar. Without it the compact wording keeps its previous output
 * for callers that only choose a language.
 */
function effortWord(effort: TooltipEffort, labels: ModelSwitcherTooltipLabels): string {
  return effort.value && effort.label !== 'Default' ? labels.effortLevels[effort.value] : labels.effortDefault;
}

function localizedNativeTooltip(args: Parameters<typeof formatNativeModelSwitcherTooltip>[0], labels: ModelSwitcherTooltipLabels): string {
  const model = `${args.displayProvider}/${args.displayModel}`;
  const modelLine = args.adaptive
    ? interpolate(labels.adaptive, { model: args.currentModel })
    : args.overridden
      ? interpolate(labels.overridden, { model, original: args.currentModel })
      : `${labels.mainModel}: ${model}`;
  return [
    modelLine,
    `${labels.engine}: ${args.engineLabel}`,
    args.billingSummary ? `${labels.billing}: ${labels.billingModes[args.billingSummary.mode]}` : null,
    args.healthSummary ? `${labels.provider}: ${labels.health[args.healthSummary.state]}` : null,
    args.effort ? `${labels.effort}: ${effortWord(args.effort, labels)}` : null,
    typeof args.thinkingEnabled === 'boolean'
      ? `${labels.thinking}: ${args.thinkingEnabled ? labels.thinkingOn : labels.thinkingOff}`
      : null,
  ].filter(Boolean).join(' · ');
}

export function formatNativeModelSwitcherTooltip(args: {
  language?: Language;
  labels?: ModelSwitcherTooltipLabels;
  engineLabel: string;
  currentModel: string;
  displayProvider: ModelProvider;
  displayModel: string;
  adaptive: boolean;
  overridden: boolean;
  billingSummary?: ProviderBillingSummary | null;
  healthSummary?: ProviderHealthSummary | null;
  effort?: TooltipEffort | null;
  thinkingLabel?: string | null;
  /** Used with `labels`; says whether thinking is on (null/undefined hides the field). */
  thinkingEnabled?: boolean | null;
}): string {
  if (args.labels) return localizedNativeTooltip(args, args.labels);
  const language = args.language ?? 'zh';
  const labels = languages[language].modelSwitcherTooltip;
  const modelLine = args.adaptive
    ? `自动路由（按任务、成本和能力切换，当前主任务 ${args.currentModel}）`
    : args.overridden
      ? `已覆盖: ${args.displayProvider}/${args.displayModel} (原主任务: ${args.currentModel})`
      : `主任务模型: ${args.displayProvider}/${args.displayModel}`;
  return [
    modelLine,
    args.billingSummary ? `计费: ${args.billingSummary.label}` : null,
    args.healthSummary && args.healthSummary.state !== 'unknown'
      ? `${labels.service}: ${args.healthSummary.label}` : null,
    args.effort ? `${labels.effort}: ${language === 'zh' ? args.effort.shortLabel : args.effort.label}` : null,
    args.thinkingLabel ? `${labels.thinking}: ${args.thinkingLabel}` : null,
  ].filter(Boolean).join(' · ');
}

export function formatExternalModelSwitcherTooltip(args: {
  language?: Language;
  labels?: ModelSwitcherTooltipLabels;
  engineLabel: string;
  model?: string | null;
  effort?: TooltipEffort | null;
  reliabilityLabel?: string | null;
}): string {
  if (args.labels) {
    const { labels } = args;
    return [
      `${labels.engine}: ${args.engineLabel}`,
      `${labels.mainModel}: ${args.model ?? labels.defaultModel}`,
      args.effort ? `${labels.effort}: ${effortWord(args.effort, labels)}` : null,
      args.reliabilityLabel ? `${labels.status}: ${args.reliabilityLabel}` : null,
    ].filter(Boolean).join(' · ');
  }
  const language = args.language ?? 'zh';
  const labels = languages[language].modelSwitcherTooltip;
  return [
    `${labels.engine}: ${args.engineLabel}`,
    `主任务模型: ${args.model ?? '默认模型'}`,
    args.effort ? `${labels.effort}: ${language === 'zh' ? args.effort.shortLabel : args.effort.label}` : null,
    args.reliabilityLabel ? `${labels.service}: ${args.reliabilityLabel}` : null,
  ].filter(Boolean).join(' · ');
}
