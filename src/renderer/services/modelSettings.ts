import type { AppSettings } from '@shared/contract';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, getProviderEndpointForProtocol } from '@shared/constants';
import { fallbackModelForProvider } from '@shared/modelRuntime';
import { resolveConfiguredDefaultProvider } from '@shared/modelDefaults';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import ipcService from './ipcService';
import { applyRendererPrivacyFlags, readReportedTelemetryEnv, resolvePrivacyFlags } from '../observability/privacyFlags';

/** Both startup and an explicit retry apply the same configured model defaults. */
export function applyModelSettings(settings: AppSettings | undefined): void {
  if (settings?.models) {
    const provider = resolveConfiguredDefaultProvider(settings.models, DEFAULT_PROVIDER);
    const config = settings.models.providers?.[provider];
    if (config) {
      const model = config.model || fallbackModelForProvider(provider, settings) || DEFAULT_MODEL;
      const modelSettings = config.models?.[model];
      useAppStore.getState().setModelConfig({
        provider, model, apiKey: config.apiKey || '',
        baseUrl: config.baseUrl || getProviderEndpointForProtocol(provider, config.protocol) || '',
        protocol: config.protocol,
        temperature: config.temperature ?? 0.7,
        maxTokens: modelSettings?.maxTokens ?? config.maxTokens ?? 4096,
        capabilities: modelSettings?.capabilities,
      });
    }
  }
  useAppStore.setState({ settingsLoaded: true });
}

/** User initiated recovery; reject on failure and keep the unconfirmed placeholder. */
export async function loadModelSettings(): Promise<void> {
  const settings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
  applyRendererPrivacyFlags(resolvePrivacyFlags(settings, readReportedTelemetryEnv()));
  applyModelSettings(settings);
}
