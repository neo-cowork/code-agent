import type { ModelProvider, ModelProviderSettings } from '@shared/contract';
import { providerRequiresApiKey } from './ModelSettings.helpers';

/** Settings choices stay selectable while explaining the missing credential. */
export function modelKeyOptionLabel(
  label: string,
  provider: ModelProvider,
  config: ModelProviderSettings | undefined,
  suffix: string,
): string {
  return providerRequiresApiKey(provider) && !(config?.apiKeyConfigured || config?.apiKey)
    ? `${label}${suffix}` : label;
}
