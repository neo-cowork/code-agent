import React from 'react';
import type { AppSettings, ModelProvider } from '@shared/contract';
import { hasConfiguredRuntimeModels } from '@shared/modelRuntime';
import { Button } from '../../../primitives';
import { useI18n } from '../../../../hooks/useI18n';
import { useAppStore } from '../../../../stores/appStore';
import { isWebMode } from '../../../../utils/platform';

export function ModelKeyGuide({ settings, defaultProvider }: {
  settings: AppSettings | null;
  defaultProvider: ModelProvider;
}) {
  const { t } = useI18n();
  const openModelSettings = useAppStore((state) => state.openModelSettings);
  if (!settings || hasConfiguredRuntimeModels(settings)) return null;
  const web = isWebMode();
  return (
    <div data-model-key-guide role="status" className="flex items-center justify-between gap-3 rounded-lg border border-border-strong bg-void px-4 py-3 text-sm text-text-primary">
      <span>{web ? t.modelSetup.noModelWeb : t.modelSetup.noModelDesktop}</span>
      {!web && (
        <Button variant="secondary" size="sm" onClick={() => openModelSettings(defaultProvider)}>
          {t.modelSetup.addModel}
        </Button>
      )}
    </div>
  );
}
