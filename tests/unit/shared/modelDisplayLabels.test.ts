import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODELS,
  PROVIDER_FALLBACK_CHAIN,
  PROVIDER_MODELS,
  QUICK_LANE_LOW_REASONING_EFFORT_MODELS,
  getModelDisplayLabel,
} from '../../../src/shared/constants';
import { PROVIDER_REGISTRY } from '../../../src/host/model/providerRegistry';
import { buildRuntimeModelOptions, getRuntimeModelLabel } from '../../../src/shared/modelRuntime';

const EXPECTED_ZHIPU_MODEL_IDS = [
  'glm-5.1',
  'glm-5',
  'glm-4.7',
  'glm-4.7-flash',
  'glm-4.7-flashx',
  'glm-5.3-flash',
  'glm-4-flash',
  'glm-4.6v',
  'glm-4.6v-flash',
];

describe('runtime model display labels', () => {
  it("returns a friendly label for the runtime-only GLM-5.3 target", () => {
    expect(getModelDisplayLabel('glm-5.3')).toBe('GLM-5.3');
  });

  // curated 标签恰好与机械回落形态同形的注册表 id（如 'qwen-max' → 'Qwen Max'）。
  // 对它们「label ≠ 回落形态」无法证明 curated；其余 id 删掉表中条目会立刻被下方门打红。
  // 名单由全量比对得出（131 个注册模型里 31 个），新增/改标签后请重新生成。
  const CURATED_EQUALS_FALLBACK_FORM = new Set([
    'LongCat-2.0',
    'MiniMax-M2.5',
    'MiniMax-M2.7',
    'custom-model',
    'doubao-1.5-thinking-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-3-flash',
    'gemini-3-pro',
    'kimi-k2-thinking',
    'kimi-k2.5',
    'kimi-k2.6',
    'qwen-coder-plus',
    'qwen-image-max',
    'qwen-max',
    'qwen-omni-turbo',
    'qwen-plus',
    'qwen-plus-latest',
    'qwen-turbo',
    'qwen3-coder',
    'qwen3-coder-flash',
    'qwen3-coder-plus',
    'qwen3-max',
    'qwen3-omni-flash',
    'sonar',
    'sonar-deep-research',
    'sonar-pro',
    'sonar-reasoning',
    'sonar-reasoning-pro',
    'text-embedding-v4',
  ]);

  it("labels every PROVIDER_REGISTRY model id so the switcher never shows a raw id", () => {
    const providers = Object.values(PROVIDER_REGISTRY);
    const registryIds = providers.flatMap((provider) =>
      provider.models.map((model) => model.id));

    expect(registryIds.length).toBeGreaterThan(0);
    for (const provider of providers) {
      for (const model of provider.models) {
        expect(getModelDisplayLabel(model.id), `${provider.id}: ${model.id}`).not.toBe(model.id);
        // 未登记 id 现在也会被回落成可读名（≠ 自身），单比「≠ id」已挡不住裸 id 回流；
        // 追加比对「该 id 的机械回落形态」（`<id>-unlisted` 的回落去掉 Unlisted 后缀）：
        // 注册表模型必须有 curated 标签，删掉 MODEL_LABELS 条目会退化成回落形态而立刻红。
        const fallbackForm = getModelDisplayLabel(`${model.id}-unlisted`).replace(/ Unlisted$/, '');
        if (!CURATED_EQUALS_FALLBACK_FORM.has(model.id)) {
          expect(getModelDisplayLabel(model.id), `${provider.id}: ${model.id} curated label degenerated to fallback form`).not.toBe(fallbackForm);
        }
      }
    }
  });

  it("derives a readable name for unlisted ids instead of returning the raw id", () => {
    expect(getModelDisplayLabel('my-custom-model-v2')).toBe('My Custom Model V2');
    expect(getModelDisplayLabel('relay_model_id')).toBe('Relay Model Id');
    expect(getModelDisplayLabel('a--_b')).toBe('A B'); // 空段丢弃
    expect(getModelDisplayLabel('')).toBe('');
  });

  it("getRuntimeModelLabel falls back to the readable name when the custom label is empty or blank", () => {
    const settingsWithLabel = (label?: string) => ({
      models: {
        default: 'openai',
        providers: {
          openai: {
            enabled: true,
            apiKeyConfigured: true,
            models: { 'my-custom-model-v2': { enabled: true, label } },
          },
        },
        routing: {},
      },
    } as never);

    expect(getRuntimeModelLabel('my-custom-model-v2', 'openai', settingsWithLabel(''))).toBe('My Custom Model V2');
    expect(getRuntimeModelLabel('my-custom-model-v2', 'openai', settingsWithLabel('   '))).toBe('My Custom Model V2');
    expect(getRuntimeModelLabel('my-custom-model-v2', 'openai', settingsWithLabel('My Relay'))).toBe('My Relay');
    expect(getRuntimeModelLabel('my-custom-model-v2')).toBe('My Custom Model V2');
  });

  it("labels the neohorse runtime-only target with the friendly NeoHorse name", () => {
    expect(getModelDisplayLabel('neohorse-1.5-flash-preview')).toBe('NeoHorse 1.5 Flash');
  });

  it('keeps the catalog zhipu model-id list unchanged', () => {
    expect(PROVIDER_MODELS.find((provider) => provider.id === 'zhipu')?.models.map((model) => model.id))
      .toEqual(EXPECTED_ZHIPU_MODEL_IDS);
  });

  it('covers default, quick-lane, and fallback-chain model ids with readable labels', () => {
    const fallbackTargets = Object.values(PROVIDER_FALLBACK_CHAIN)
      .flat()
      .map(({ model }) => model);
    const modelIds = new Set([
      ...Object.values(DEFAULT_MODELS),
      ...QUICK_LANE_LOW_REASONING_EFFORT_MODELS,
      ...fallbackTargets,
    ]);

    for (const modelId of modelIds) {
      expect(getModelDisplayLabel(modelId), modelId).not.toBe(modelId);
    }
  });

  it('uses the shared label for runtime-only models in settings options', () => {
    const settings = {
      models: {
        default: 'zhipu',
        providers: {
          zhipu: {
            enabled: true,
            apiKeyConfigured: true,
            models: {
              'glm-5.3': { enabled: true },
            },
          },
        },
        routing: {},
      },
    } as never;

    expect(buildRuntimeModelOptions(settings, ['zhipu']).find((option) => option.model === 'glm-5.3')?.label)
      .toBe('GLM-5.3');
  });

  it('renders configured gpt-4o / qwen-max as friendly labels instead of raw ids', () => {
    expect(getRuntimeModelLabel('gpt-4o')).toBe('GPT-4o');
    expect(getRuntimeModelLabel('qwen-max')).toBe('Qwen Max');

    const settings = {
      models: {
        default: 'openai',
        providers: {
          openai: {
            enabled: true,
            apiKeyConfigured: true,
            models: {
              'gpt-4o': { enabled: true },
            },
          },
          qwen: {
            enabled: true,
            apiKeyConfigured: true,
            models: {
              'qwen-max': { enabled: true },
            },
          },
        },
        routing: {},
      },
    } as never;

    const options = buildRuntimeModelOptions(settings, ['openai', 'qwen']);
    expect(options.find((option) => option.model === 'gpt-4o')?.label).toBe('GPT-4o');
    expect(options.find((option) => option.model === 'qwen-max')?.label).toBe('Qwen Max');
  });
});
