// 模型目录 label 以英文为源。中文界面只在传入的 label 仍等于目录默认值时换回原中文限定词；
// 用户改过的名字（与目录默认值不同）保持原样。同 providerDisplay：英文界面统一英文名。
import { PROVIDER_MODELS } from '@shared/constants';
import type { Language } from './index';

/** model id → 改成英文之前的目录 label。只覆盖这 11 个带中文限定词的条目。 */
const ZH_MODEL_LABELS: Record<string, string> = {
  'deepseek-v4-pro': 'DeepSeek V4 Pro (推理)',
  'deepseek-v4-flash': 'DeepSeek V4 Flash（兼容名）',
  'deepseek-chat': 'DeepSeek Chat（旧版）',
  'deepseek-reasoner': 'DeepSeek Reasoner（旧版）',
  'glm-4.7-flash': 'GLM-4.7 Flash (免费)',
  'glm-4-flash': 'GLM-4 Flash (免费)',
  'glm-4.6v': 'GLM-4.6V (视觉)',
  'qwen-vl-max': 'Qwen VL Max (视觉)',
  'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash（兼容名）',
  'qwen3.5:9b': 'Qwen3.5 9B 原版',
  'huihui_ai/qwen3.5-abliterated:9b-Qwopus-q4_K': 'Qwen3.5 9B Qwopus (agent 调优)',
};

const catalogLabelsById = new Map<string, Set<string>>();
for (const provider of PROVIDER_MODELS) {
  for (const model of provider.models) {
    const labels = catalogLabelsById.get(model.id) ?? new Set<string>();
    labels.add(model.label);
    catalogLabelsById.set(model.id, labels);
  }
}

for (const modelId of Object.keys(ZH_MODEL_LABELS)) {
  if (!catalogLabelsById.has(modelId)) {
    throw new Error(`localizeModelLabel override "${modelId}" is not in the model catalog`);
  }
}

/** 中文界面且 label 仍是目录默认值时返回原中文；否则原样返回（含英文界面与用户自命名）。 */
export function localizeModelLabel(modelId: string, label: string, language: Language): string {
  if (language !== 'zh') return label;
  const zhLabel = ZH_MODEL_LABELS[modelId];
  if (!zhLabel) return label;
  const defaults = catalogLabelsById.get(modelId);
  if (!defaults?.has(label)) return label;
  return zhLabel;
}
