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

  it("labels every PROVIDER_REGISTRY model id so the switcher never shows a raw id", () => {
    const providers = Object.values(PROVIDER_REGISTRY);
    const registryIds = providers.flatMap((provider) =>
      provider.models.map((model) => model.id));

    expect(registryIds.length).toBeGreaterThan(0);
    for (const provider of providers) {
      for (const model of provider.models) {
        expect(getModelDisplayLabel(model.id), `${provider.id}: ${model.id}`).not.toBe(model.id);
      }
    }
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
