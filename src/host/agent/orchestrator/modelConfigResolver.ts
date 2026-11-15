// ============================================================================
// Model Config Resolution - Provider/model selection logic
// ============================================================================

import type { ModelConfig, ModelProvider, PermissionRequest } from '../../../shared/contract';
import type { ConversationModelSpec } from '../../../shared/contract/conversationEnvelope';
import type { RoutingResolution } from '../../../shared/contract/agentRouting';
import type { ConfigService } from '../../services/core/configService';
import { getModelSessionState } from '../../session/modelSessionState';
import {
  DEFAULT_PROVIDER,
  getModelMaxOutputTokens,
} from '../../../shared/constants';
import { fallbackModelForProvider } from '../../../shared/modelRuntime';
import { createLogger } from '../../services/infra/logger';
import { resolveConfiguredDefaultProvider } from '../../../shared/modelDefaults';

import { resolveConfiguredProvider } from '../../model/configuredProvider';

const logger = createLogger('ModelConfigResolver');

/**
 * 根据用户设置解析完整的 ModelConfig
 */
export function resolveModelConfig(
  configService: ConfigService,
  settings: ReturnType<ConfigService['getSettings']>
): ModelConfig {
  // 从用户配置获取选择的 provider 和 model
  const userProviderStr = resolveConfiguredDefaultProvider(settings.models, DEFAULT_PROVIDER);
  const { connection, providerConfig } = resolveConfiguredProvider(configService, settings, userProviderStr);
  const normalizedProvider = connection.provider;
  const userModel = providerConfig?.model || getDefaultModelByProvider(normalizedProvider, settings);
  const maxTokens = providerConfig?.models?.[userModel]?.maxTokens
    ?? providerConfig?.maxTokens
    ?? getModelMaxOutputTokens(userModel, normalizedProvider);

  // 获取对应的 API Key
  const selectedApiKey = connection.apiKey;

  const selectedProvider: ModelProvider = normalizedProvider;
  const selectedModel = userModel;

  logger.info(`[模型选择] 用户配置: provider=${selectedProvider}, model=${selectedModel}, hasApiKey=${!!selectedApiKey}`);

  if (!selectedApiKey) {
    logger.warn(`[模型选择] 未配置 ${selectedProvider} API Key，请在设置中配置本地 API Key`);
  }

  return {
    ...connection,
    model: selectedModel,
    temperature: 0.7,
    maxTokens,
  };
}

export function resolveRunModelConfig(
  configService: ConfigService,
  settings: ReturnType<ConfigService['getSettings']>,
  sessionId: string | null,
  explicitModelSpec?: ConversationModelSpec,
): ModelConfig {
  // 换 provider 时 apiKey/baseUrl 必须跟着换，**不能沿用上一个 provider 的值**：
  // 沿用会变成「拿 A 家的 key 打 B 家的端点」——既永远认证失败（2026-07-28 真机实测：
  // 会话切到 deepseek，请求却打到智谱代理 api.0ki.cn，401），也是把凭据发给第三方。
  // 目标 provider 没单独配就留 undefined，由 providerResolution（baseURL/apiKey 的
  // 单一事实来源）按 provider 补 MODEL_API_ENDPOINTS 默认端点与 env key。
  let modelConfig = resolveModelConfig(configService, settings);
  if (explicitModelSpec) {
    const { connection } = resolveConfiguredProvider(configService, settings, explicitModelSpec.provider);
    return {
      ...modelConfig,
      ...connection,
      model: explicitModelSpec.model,
      adaptive: false,
    };
  }

  const override = sessionId ? getModelSessionState().getOverride(sessionId) : null;
  if (override?.adaptive === true) {
    logger.info('[模型选择] session 选了"自动"，使用默认模型 + adaptiveRouter');
    return { ...modelConfig, adaptive: true };
  }
  if (override) {
    const { connection } = resolveConfiguredProvider(configService, settings, override.provider);
    modelConfig = {
      ...modelConfig,
      ...connection,
      model: override.model,
      temperature: override.temperature ?? modelConfig.temperature,
      maxTokens: override.maxTokens ?? modelConfig.maxTokens,
      adaptive: false,
    };
    logger.info(`[模型选择] 使用 session override: provider=${override.provider}, model=${override.model}`);
  }
  return modelConfig;
}

/**
 * 获取 provider 的默认模型
 */
export function getDefaultModelByProvider(provider: string, settings?: Parameters<typeof fallbackModelForProvider>[1]): string {
  return fallbackModelForProvider(provider, settings);
}

/**
 * 将权限请求类型映射为权限级别
 */
export function getPermissionLevel(type: PermissionRequest['type']): 'read' | 'write' | 'execute' | 'network' {
  switch (type) {
    case 'file_read':
      return 'read';
    case 'file_write':
    case 'file_edit':
      return 'write';
    case 'command':
    case 'dangerous_command':
      return 'execute';
    case 'network':
      return 'network';
    case 'directory_access':
      return 'write';
    default:
      return 'read';
  }
}

/**
 * 本轮有效模型配置：显式 /agent 路由带 modelOverride 且未被 Neo Tag fixed_model 钉死时，
 * 用 override 覆盖 provider/model/temperature；否则原样返回 modelConfig。纯计算，
 * 路由日志与 routing_resolved 事件仍由调用点发（副作用不进此函数）。
 */
export function resolveTurnModelConfig(
  modelConfig: ModelConfig,
  routingResolution: RoutingResolution | null,
  neoTagFixedModel: boolean,
): ModelConfig {
  const override = routingResolution?.agent.modelOverride;
  if (!override || neoTagFixedModel) return modelConfig;
  return {
    ...modelConfig,
    provider: (override.provider as ModelProvider) || modelConfig.provider,
    model: override.model || modelConfig.model,
    temperature: override.temperature ?? modelConfig.temperature,
  };
}
