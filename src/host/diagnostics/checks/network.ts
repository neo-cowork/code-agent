// ============================================================================
// Doctor Check - Network 连通性
// 对**已配置 API Key** 的 provider 跑 handleTestConnection；
// 未配置的标 `skip`，不计入 fail。
// ============================================================================

import { DOCTOR_FIX_CODES, PROVIDER_REGISTRY, getDefaultModelForProvider } from '../../../shared/constants';
import type { DoctorFixCode } from '../../../shared/constants';
import type { BuiltInModelProvider } from '../../../shared/contract';
import { handleTestConnection } from '../../model/providerConnectionTest';
import { getProviderHealthMonitor } from '../../model/providerHealthMonitor';
import { resolveProviderApiKey, resolveProviderBaseUrl } from '../../model/providers/providerResolution';
import { DOCTOR_PROBE_REAL_SUCCESS_MAX_AGE_MS } from '../../../shared/constants/doctor';
import { getConfigService } from '../../services/core/configService';
import type { DoctorItem } from '../types';

function getConnectivityFixCode(errorCode: string | undefined): DoctorFixCode {
  switch (errorCode) {
    case 'AUTH_FAILED':
    case 'FORBIDDEN':
    case 'RATE_LIMITED':
    case 'API_ERROR':
    case 'UNSUPPORTED_PROVIDER':
      return DOCTOR_FIX_CODES.OPEN_PROVIDER_SETTINGS;
    default:
      return DOCTOR_FIX_CODES.OPEN_PROXY_HELP;
  }
}

/**
 * 检查所有已配置 provider 的连通性。
 * 未配置 API Key 的 provider 返回 `skip` 项。
 * 单项失败映射：
 *   - HTTP 200 → pass
 *   - TIMEOUT → warn（不视为 fail，可能只是网络慢）
 *   - 401/403 → fail；近期真实调用成功时为 warn（测试路径可能不同）
 *   - 其他 → warn
 */
export async function checkProviderConnectivity(): Promise<DoctorItem[]> {
  const config = getConfigService();
  const settings = config.getSettings();
  const providerEntries = Object.entries(PROVIDER_REGISTRY) as Array<
    [BuiltInModelProvider, (typeof PROVIDER_REGISTRY)[BuiltInModelProvider]]
  >;

  const results = await Promise.allSettled(
    providerEntries.map(async ([providerId, info]): Promise<DoctorItem> => {
      const providerSettings = settings.models.providers[providerId];
      const modelConfig = {
        provider: providerId,
        model: providerSettings?.model || getDefaultModelForProvider(providerId),
        baseUrl: providerSettings?.baseUrl,
        protocol: providerSettings?.protocol,
      };
      const apiKey = resolveProviderApiKey(modelConfig, { trustConfigKey: false });
      if (!apiKey) {
        return {
          category: 'network',
          name: info.displayName,
          status: 'skip',
          message: '未配置 API Key',
        };
      }

      const started = Date.now();
      try {
        const result = await handleTestConnection({
          provider: providerId,
          apiKey,
          baseUrl: resolveProviderBaseUrl(modelConfig),
          protocol: modelConfig.protocol,
          model: modelConfig.model,
        });
        const durationMs = Date.now() - started;

        if (result.success) {
          return {
            category: 'network',
            name: info.displayName,
            status: 'pass',
            message: `${result.latencyMs}ms`,
            durationMs,
          };
        }

        const code = result.error?.code;
        const isFail = code === 'AUTH_FAILED' || code === 'FORBIDDEN';
        const health = getProviderHealthMonitor().getHealth(providerId);
        if (isFail && health && health.lastSuccessAt > 0
          && Date.now() - health.lastSuccessAt <= DOCTOR_PROBE_REAL_SUCCESS_MAX_AGE_MS) {
          const probeHttpStatus = code === 'AUTH_FAILED' ? 401 : 403;
          const message = `The test address returned ${probeHttpStatus}, but your recent real calls succeeded — the test path may differ from the real one.`;
          return {
            category: 'network',
            name: info.displayName,
            status: 'warn',
            message,
            probeHttpStatus,
            details: message,
            durationMs,
          };
        }
        return {
          category: 'network',
          name: info.displayName,
          status: isFail ? 'fail' : 'warn',
          message: result.error?.message ?? '连接失败',
          suggestion: result.error?.suggestion,
          details: code,
          durationMs,
          fix: { code: getConnectivityFixCode(code) },
        };
      } catch (err) {
        return {
          category: 'network',
          name: info.displayName,
          status: 'warn',
          message: `内部错误: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: Date.now() - started,
          fix: { code: DOCTOR_FIX_CODES.OPEN_PROXY_HELP },
        };
      }
    }),
  );

  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          category: 'network' as const,
          name: providerEntries[i][1].displayName,
          status: 'warn' as const,
          message: '检查异常',
          details: r.reason instanceof Error ? r.reason.message : String(r.reason),
          fix: { code: DOCTOR_FIX_CODES.OPEN_PROXY_HELP },
        },
  );
}
