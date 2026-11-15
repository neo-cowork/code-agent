import type { ModelProvider } from '../../shared/contract';
import type { IReadConfigService } from '../../shared/contract/configService';
import { normalizeProviderId } from '../../shared/constants';

/** Resolve credentials and transport settings together for the selected provider. */
export function resolveConfiguredProvider(
  configService: Pick<IReadConfigService, 'getApiKey'>,
  settings: ReturnType<IReadConfigService['getSettings']>,
  providerId: string,
) {
  const provider = (normalizeProviderId(providerId) ?? providerId) as ModelProvider;
  const providerConfig = settings.models?.providers?.[provider]
    ?? settings.models?.providers?.[providerId];
  return {
    providerConfig,
    connection: {
      provider,
      apiKey: configService.getApiKey(provider),
      baseUrl: providerConfig?.baseUrl,
      protocol: providerConfig?.protocol,
    },
  };
}
