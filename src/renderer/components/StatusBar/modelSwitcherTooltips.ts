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
  /** host 这一轮把模型换掉了（路由/回落）：显示真正在用的那个，并说清从哪个换来 */
  switchedFrom?: { provider: string; model: string; reason: string } | null;
  shownProvider?: string;
  shownModel?: string;
}): string {
  const language = args.language ?? 'zh';
  const labels = languages[language].modelSwitcherTooltip;
  const modelLine = args.switchedFrom
    ? `这一轮实际在用: ${args.shownProvider}/${args.shownModel}（你选的是 ${args.switchedFrom.provider}/${args.switchedFrom.model}，已自动换过）`
    : args.adaptive
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
  engineLabel: string;
  model: string;
  effort?: Pick<EffortOption, 'label' | 'shortLabel'> | null;
  reliabilityLabel?: string | null;
}): string {
  const language = args.language ?? 'zh';
  const labels = languages[language].modelSwitcherTooltip;
  return [
    `${labels.engine}: ${args.engineLabel}`,
    `主任务模型: ${args.model}`,
    args.effort ? `${labels.effort}: ${language === 'zh' ? args.effort.shortLabel : args.effort.label}` : null,
    args.reliabilityLabel ? `${labels.service}: ${args.reliabilityLabel}` : null,
  ].filter(Boolean).join(' · ');
}
