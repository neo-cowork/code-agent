import type { AppSettings, ModelProvider, ModelProviderSettings } from '../../../shared/contract';
import type { SecureStorageService } from './secureStorage';
import { getCloudManagedProviderKeyId, normalizeApiKey } from './configHelpers';
import { PROVIDER_ENV_KEY_MAP } from './configServiceInternal';

/** Resolve the runtime credential and its origin together, including legacy migration. */
export function resolveProviderKey(
  provider: ModelProvider,
  settings: AppSettings,
  storage: Pick<SecureStorageService, 'getApiKey' | 'setApiKey'>,
): { key?: string; source?: ModelProviderSettings['apiKeySource'] } {
  const providerConfig = settings.models.providers[provider];
  const secureKey = normalizeApiKey(storage.getApiKey(provider));
  if (secureKey) return { key: secureKey, source: providerConfig?.managedByCloud ? 'account' : 'saved' };

  const configKey = normalizeApiKey(providerConfig?.apiKey);
  if (configKey) {
    storage.setApiKey(provider, configKey);
    delete providerConfig?.apiKey;
    return { key: configKey, source: 'saved' };
  }

  const managedKey = normalizeApiKey(storage.getApiKey(getCloudManagedProviderKeyId(provider)));
  if (managedKey) return { key: managedKey, source: 'account' };

  const envName = PROVIDER_ENV_KEY_MAP[provider];
  const envKey = normalizeApiKey(envName ? process.env[envName] : undefined);
  if (envKey) return { key: envKey, source: 'environment' };
  if (provider === 'moonshot') {
    const aliasKey = normalizeApiKey(process.env.KIMI_K25_API_KEY);
    if (aliasKey) return { key: aliasKey, source: 'environment' };
  }
  return {};
}
