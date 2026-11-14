import type {
  ModelConfig,
  ModelEntrySettings,
  ModelProvider,
  ModelProviderProtocol,
  ModelProviderSettings,
} from '@shared/contract';
import { DEFAULT_MODEL, MODEL, PROVIDER_MODELS_MAP, getProviderInfo } from '@shared/constants';
import { getProviderRuntimeModels } from '@shared/modelRuntime';
import type { Translations } from '../../i18n/zh';

export type OnboardingTranslations = Translations['onboarding'];

export interface OnboardingProviderCopy {
  id: ModelProvider;
  name: string;
  description: string;
  badge?: string;
  recommended: boolean;
  /** 中转站/自定义卡片：需要用户填 Base URL，模型列表完全依赖在线发现 */
  requiresBaseUrl?: boolean;
}

export interface OnboardingDiscoveredModel {
  id: string;
  label: string;
  capabilities?: ModelConfig['capabilities'];
  maxTokens?: number;
  supportsTool?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
}

export interface OnboardingModelSelection {
  modelConfig: ModelConfig;
  providerSettings: ModelProviderSettings;
}

export const ONBOARDING_OFFICIAL_PROVIDERS = [
  'deepseek',
  'moonshot',
  'zhipu',
  'qwen',
  'openai',
  'claude',
  'gemini',
  'minimax',
  'grok',
  'groq',
  'perplexity',
  'volcengine',
  'longcat',
  'xiaomi',
] as const satisfies readonly ModelProvider[];

export const ONBOARDING_RECOMMENDED_PROVIDERS: readonly ModelProvider[] = [
  'deepseek',
  'moonshot',
  'zhipu',
  'qwen',
];

/** 中转站/自定义卡片（OpenAI 兼容），让只有中转 key 的新用户也能完成 onboarding */
export function getOnboardingRelayCard(text: OnboardingTranslations): OnboardingProviderCopy {
  return {
    id: 'custom',
    name: text.providerCards.relay.name,
    description: text.providerCards.relay.description,
    badge: text.providerCards.relay.badge,
    recommended: false,
    requiresBaseUrl: true,
  };
}

/** Onboarding is deliberately two steps: source, then its default model. */
export const ONBOARDING_STEPS = ['source', 'model'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type OnboardingRoute = 'subscription' | 'api';

export interface OnboardingApiCompatibilityOption {
  id: 'openai-compatible' | 'anthropic-compatible';
  label: string;
  description: string;
  protocol: ModelProviderProtocol;
}

export function getOnboardingApiCompatibilityOptions(
  text: OnboardingTranslations,
): readonly OnboardingApiCompatibilityOption[] {
  return [
    {
      id: 'openai-compatible',
      label: text.providerCards.compatibility['openai-compatible'].label,
      description: text.providerCards.compatibility['openai-compatible'].description,
      protocol: 'openai',
    },
    {
      id: 'anthropic-compatible',
      label: text.providerCards.compatibility['anthropic-compatible'].label,
      description: text.providerCards.compatibility['anthropic-compatible'].description,
      protocol: 'claude',
    },
  ];
}

export function getOnboardingProviderCards(text: OnboardingTranslations): OnboardingProviderCopy[] {
  return ONBOARDING_OFFICIAL_PROVIDERS.map((id) => {
    const copy: { name: string; description: string; badge?: string } = text.providerCards[id];
    return {
      id,
      name: copy.name,
      description: copy.description,
      badge: copy.badge,
      recommended: ONBOARDING_RECOMMENDED_PROVIDERS.includes(id),
    };
  });
}

export function selectOnboardingDefaultModel(
  provider: ModelProvider,
  discoveredModels: OnboardingDiscoveredModel[] = [],
): string {
  const providerDefault = getProviderInfo(provider)?.defaultModel;
  if (providerDefault && discoveredModels.some((model) => model.id === providerDefault)) {
    return providerDefault;
  }
  if (discoveredModels[0]?.id) {
    return discoveredModels[0].id;
  }
  return providerDefault || getProviderRuntimeModels(PROVIDER_MODELS_MAP[provider]).find(Boolean)?.id || DEFAULT_MODEL;
}

function getBuiltinModelEntry(provider: ModelProvider, modelId: string): ModelEntrySettings {
  const runtimeModels = getProviderRuntimeModels(PROVIDER_MODELS_MAP[provider]);
  const runtimeModel = runtimeModels.find((model) => model.id === modelId)
    || runtimeModels.find(Boolean);
  return {
    enabled: true,
    label: runtimeModel?.label || modelId,
    capabilities: runtimeModel?.capabilities,
    maxTokens: runtimeModel?.maxTokens,
    supportsTool: runtimeModel?.supportsTool,
    supportsVision: runtimeModel?.supportsVision,
    supportsStreaming: runtimeModel?.supportsStreaming,
  };
}

export function buildOnboardingModelSelection({
  provider,
  apiKey,
  baseUrl,
  protocol,
  preferredModelId,
  discoveredModels = [],
}: {
  provider: ModelProvider;
  apiKey: string;
  baseUrl?: string;
  protocol?: ModelProviderProtocol;
  preferredModelId?: string;
  discoveredModels?: OnboardingDiscoveredModel[];
}): OnboardingModelSelection {
  const selectedModel = preferredModelId?.trim()
    && discoveredModels.some((model) => model.id === preferredModelId.trim())
    ? preferredModelId.trim()
    : selectOnboardingDefaultModel(provider, discoveredModels);
  const modelEntries: Record<string, ModelEntrySettings> = {};
  const discoveredAt = Date.now();

  for (const model of discoveredModels) {
    modelEntries[model.id] = {
      enabled: true,
      label: model.label || model.id,
      capabilities: model.capabilities,
      maxTokens: model.maxTokens,
      supportsTool: model.supportsTool,
      supportsVision: model.supportsVision,
      supportsStreaming: model.supportsStreaming,
      discoveredAt,
    };
  }

  if (!modelEntries[selectedModel]) {
    modelEntries[selectedModel] = getBuiltinModelEntry(provider, selectedModel);
  }

  const providerSettings: ModelProviderSettings = {
    enabled: true,
    apiKey,
    baseUrl: baseUrl || getProviderInfo(provider)?.endpoint,
    ...(protocol ? { protocol } : {}),
    model: selectedModel,
    temperature: MODEL.DEFAULT_TEMPERATURE,
    models: modelEntries,
  };

  return {
    providerSettings,
    modelConfig: {
      provider,
      model: selectedModel,
      apiKey,
      baseUrl: providerSettings.baseUrl,
      ...(protocol ? { protocol } : {}),
      temperature: MODEL.DEFAULT_TEMPERATURE,
      maxTokens: modelEntries[selectedModel]?.maxTokens,
      capabilities: modelEntries[selectedModel]?.capabilities,
    },
  };
}
