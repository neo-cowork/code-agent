import { describe, expect, it } from 'vitest';
import { PROVIDER_MODELS } from '../../../src/shared/constants';
import { localizeModelLabel } from '../../../src/renderer/i18n/modelLabelDisplay';

const CJK_OR_FULLWIDTH_PAREN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff08\uff09]/u;

/** 公开行为应覆盖的 11 个目录条目：英文是目录默认值，中文只在 zh 且 label 仍是默认值时出现。 */
const ZH_OVERRIDE_LABELS: Record<string, { en: string; zh: string }> = {
  'deepseek-v4-pro': { en: 'DeepSeek V4 Pro (Reasoning)', zh: 'DeepSeek V4 Pro (推理)' },
  'deepseek-v4-flash': { en: 'DeepSeek V4 Flash (Alias)', zh: 'DeepSeek V4 Flash（兼容名）' },
  'deepseek-chat': { en: 'DeepSeek Chat (Legacy)', zh: 'DeepSeek Chat（旧版）' },
  'deepseek-reasoner': { en: 'DeepSeek Reasoner (Legacy)', zh: 'DeepSeek Reasoner（旧版）' },
  'glm-4.7-flash': { en: 'GLM-4.7 Flash (Free)', zh: 'GLM-4.7 Flash (免费)' },
  'glm-4-flash': { en: 'GLM-4 Flash (Free)', zh: 'GLM-4 Flash (免费)' },
  'glm-4.6v': { en: 'GLM-4.6V (Vision)', zh: 'GLM-4.6V (视觉)' },
  'qwen-vl-max': { en: 'Qwen VL Max (Vision)', zh: 'Qwen VL Max (视觉)' },
  'deepseek/deepseek-v4-flash': { en: 'DeepSeek V4 Flash (Alias)', zh: 'DeepSeek V4 Flash（兼容名）' },
  'qwen3.5:9b': { en: 'Qwen3.5 9B (Original)', zh: 'Qwen3.5 9B 原版' },
  'huihui_ai/qwen3.5-abliterated:9b-Qwopus-q4_K': {
    en: 'Qwen3.5 9B Qwopus (Agent-tuned)',
    zh: 'Qwen3.5 9B Qwopus (agent 调优)',
  },
};

function catalogLabels(): Array<{ id: string; label: string }> {
  return PROVIDER_MODELS.flatMap((provider) => provider.models.map((model) => ({ id: model.id, label: model.label })));
}

describe('catalog model labels stay English', () => {
  it('rejects CJK and fullwidth parentheses in every PROVIDER_MODELS label', () => {
    const offenders = catalogLabels().filter((model) => CJK_OR_FULLWIDTH_PAREN.test(model.label));
    expect(offenders).toEqual([]);
  });

  it('localizes exactly the 11 catalog defaults in zh and leaves every other label unchanged', () => {
    const catalogIds = new Set(catalogLabels().map((model) => model.id));
    for (const modelId of Object.keys(ZH_OVERRIDE_LABELS)) {
      expect(catalogIds.has(modelId), modelId).toBe(true);
    }

    const overridden = new Set<string>();
    for (const model of catalogLabels()) {
      expect(localizeModelLabel(model.id, model.label, 'en')).toBe(model.label);
      const zh = localizeModelLabel(model.id, model.label, 'zh');
      const expected = ZH_OVERRIDE_LABELS[model.id];
      if (expected) {
        expect(model.label, model.id).toBe(expected.en);
        expect(zh, model.id).toBe(expected.zh);
        expect(localizeModelLabel(model.id, 'Custom name', 'zh')).toBe('Custom name');
        overridden.add(model.id);
      } else {
        expect(zh, model.id).toBe(model.label);
      }
    }

    expect([...overridden].sort()).toEqual(Object.keys(ZH_OVERRIDE_LABELS).sort());
    expect(overridden.size).toBe(11);
  });
});
