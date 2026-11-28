import type { AppSettings, ModelProvider } from '@shared/contract';
import { DEFAULT_PROVIDER } from '@shared/constants';
import { IPC_DOMAINS } from '@shared/ipc';
import { resolveConfiguredDefaultProvider } from '@shared/modelDefaults';
import { hasConfiguredRuntimeModels, hasConfiguredRuntimeProvider } from '@shared/modelRuntime';
import type { Language, Translations } from '../i18n';
import { getLocalizedProviderDisplayName } from '../i18n/providerDisplay';
import { toast } from '../hooks/useToast';
import ipcService from '../services/ipcService';
import { useAppStore } from '../stores/appStore';
import { createLogger } from './logger';
import { isOfflineTransportError } from './offlineSend';
import { isWebMode } from './platform';

const logger = createLogger('modelSetup');

export type PreSendModelReadiness = 'ready' | 'unconfigured' | 'offline';

async function readModelReadiness(
  currentSessionId: string | null,
  options: { allowCloudManaged?: boolean },
): Promise<{ settings: AppSettings; provider: ModelProvider; configured: boolean }> {
  const settings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
  const defaultProvider = resolveConfiguredDefaultProvider(settings?.models, DEFAULT_PROVIDER);
  let provider = defaultProvider;
  if (currentSessionId) {
    try {
      const effective = await ipcService.invokeDomain<{ provider: ModelProvider; model: string; adaptive?: boolean } | null>(
        IPC_DOMAINS.SESSION, 'getEffectiveModel', { sessionId: currentSessionId },
      );
      if (effective?.provider && effective.adaptive !== true && effective.model !== 'auto') provider = effective.provider;
    } catch (error) {
      logger.debug('Effective model read failed; using the default provider', { error });
    }
  }
  return { settings, provider, configured: hasConfiguredRuntimeProvider(settings, provider, options) };
}

export async function readSessionRuntimeModelState(
  currentSessionId: string | null,
  options: { allowCloudManaged?: boolean } = {},
): Promise<PreSendModelReadiness> {
  try {
    return (await readModelReadiness(currentSessionId, options)).configured ? 'ready' : 'unconfigured';
  } catch (error) {
    return isOfflineTransportError(error) ? 'offline' : 'unconfigured';
  }
}

/** Guide missing-model sends and signed-out setup to the same settings destination. */
export async function ensureModelConfigured(
  t: Translations,
  language: Language,
  { currentSessionId = null, openSettingsWhenReady = false }: { currentSessionId?: string | null; openSettingsWhenReady?: boolean } = {},
): Promise<boolean> {
  const { openSettingsTab, openModelSettings } = useAppStore.getState();
  try {
    const { settings, provider, configured } = await readModelReadiness(currentSessionId, {});
    if (!configured) {
      const noModels = !hasConfiguredRuntimeModels(settings);
      if (noModels) {
        openModelSettings(provider);
        return false;
      }
      const providerName = settings?.models?.providers?.[provider]?.displayName?.trim()
        || getLocalizedProviderDisplayName(provider, language)
        || t.modelSetup.thisModel;
      if (isWebMode()) {
        toast.info(t.modelSetup.webSetupDesktopOnly.replace('{provider}', providerName));
      } else if (!openSettingsWhenReady) {
        toast.info(t.modelSetup.missingApiKeyWithAlternatives.replace('{provider}', providerName));
      }
      openModelSettings(provider);
      return false;
    }
  } catch (error) {
    logger.debug('Settings read failed while checking model setup', { error });
  }
  if (openSettingsWhenReady) openSettingsTab('model');
  return true;
}

/** 发送前模型检查：把「连不上后台」与「没配模型」分开，离线不弹模型设置页。 */
export async function ensureModelConfiguredForSend(
  t: Translations,
  language: Language,
  currentSessionId: string | null,
): Promise<PreSendModelReadiness> {
  const { openModelSettings } = useAppStore.getState();
  try {
    const { settings, provider, configured } = await readModelReadiness(currentSessionId, {});
    if (!configured) {
      const noModels = !hasConfiguredRuntimeModels(settings);
      if (noModels) {
        openModelSettings(provider);
        return 'unconfigured';
      }
      const providerName = settings?.models?.providers?.[provider]?.displayName?.trim()
        || getLocalizedProviderDisplayName(provider, language)
        || t.modelSetup.thisModel;
      if (isWebMode()) {
        toast.info(t.modelSetup.webSetupDesktopOnly.replace('{provider}', providerName));
      } else {
        toast.info(t.modelSetup.missingApiKeyWithAlternatives.replace('{provider}', providerName));
      }
      openModelSettings(provider);
      return 'unconfigured';
    }
    return 'ready';
  } catch (error) {
    if (isOfflineTransportError(error)) return 'offline';
    logger.debug('Settings read failed while checking model setup', { error });
    return 'ready';
  }
}
