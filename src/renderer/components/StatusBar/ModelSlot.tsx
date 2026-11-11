import React from 'react';
import { useAppStore } from '../../stores/appStore';
import { useI18n } from '../../hooks/useI18n';
import { ModelSwitcher } from './ModelSwitcher';

export function ModelSlot({ currentModel }: { currentModel: string }) {
  const settingsLoaded = useAppStore((state) => state.settingsLoaded);
  const { t } = useI18n();
  if (!settingsLoaded) {
    return <span role="status" className="text-xs text-zinc-500" data-testid="model-loading">{t.sidebar.modelLoading}</span>;
  }
  return <ModelSwitcher currentModel={currentModel} />;
}
