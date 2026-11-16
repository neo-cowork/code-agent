import type { AppSettings } from '@shared/contract';
import { DEFAULT_PROVIDER } from '@shared/constants';
import { IPC_DOMAINS } from '@shared/ipc';
import { resolveConfiguredDefaultProvider } from '@shared/modelDefaults';
import { hasConfiguredDefaultRuntimeModel, hasConfiguredRuntimeModels } from '@shared/modelRuntime';
import type { Language, Translations } from '../i18n';
import { getLocalizedProviderDisplayName } from '../i18n/providerDisplay';
import { toast } from '../hooks/useToast';
import ipcService from '../services/ipcService';
import { useAppStore } from '../stores/appStore';
import { createLogger } from './logger';

const logger = createLogger('modelSetup');

/** Guide missing-model sends and signed-out setup to the same settings destination. */
export async function ensureModelConfigured(
  t: Translations,
  language: Language,
  { openSettingsWhenReady = false }: { openSettingsWhenReady?: boolean } = {},
): Promise<boolean> {
  const { openSettingsTab, openModelSettings } = useAppStore.getState();
  try {
    const settings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
    if (!hasConfiguredDefaultRuntimeModel(settings)) {
      if (hasConfiguredRuntimeModels(settings)) {
        if (!openSettingsWhenReady) toast.info(t.chat.configureModelKeyFirst);
        openSettingsTab('model');
      } else {
        const provider = resolveConfiguredDefaultProvider(settings?.models, DEFAULT_PROVIDER);
        toast.info(t.modelSetup.missingApiKey.replace('{provider}', getLocalizedProviderDisplayName(provider, language) || t.modelSetup.thisModel));
        openModelSettings(provider);
      }
      return false;
    }
  } catch (error) {
    logger.debug('Settings read failed while checking model setup', { error });
  }
  if (openSettingsWhenReady) openSettingsTab('model');
  return true;
}
