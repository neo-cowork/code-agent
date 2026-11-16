import React from 'react';
import type { AppSettings, ModelProvider } from '@shared/contract';
import { Button } from '../../../primitives';
import { useI18n } from '../../../../hooks/useI18n';
import { useAppStore } from '../../../../stores/appStore';
import { providerRequiresApiKey } from './ModelSettings.helpers';

export function ModelKeyGuide({ settings, defaultProvider }: {
  settings: AppSettings | null;
  defaultProvider: ModelProvider;
}) {
  const { t } = useI18n();
  const openModelSettings = useAppStore((state) => state.openModelSettings);
  const requiringKeys = Object.entries(settings?.models.providers ?? {})
    .filter(([provider]) => providerRequiresApiKey(provider as ModelProvider));
  if (!requiringKeys.length || requiringKeys.some(([, config]) => config.apiKeyConfigured || config.apiKey)) return null;
  const target = providerRequiresApiKey(defaultProvider) ? defaultProvider : requiringKeys[0][0] as ModelProvider;
  return (
    <div data-model-key-guide className="flex items-center justify-between gap-3 rounded-lg border border-badge-warning/30 bg-badge-warning px-4 py-3">
      <Button variant="secondary" size="sm" onClick={() => openModelSettings(target)}>
        {t.settings.model.header.noKeyGuide}
      </Button>
    </div>
  );
}
