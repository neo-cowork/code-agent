import React, { useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useI18n } from '../../hooks/useI18n';
import { loadModelSettings } from '../../services/modelSettings';
import { createLogger } from '../../utils/logger';
import { Button } from '../primitives/Button';
import { ModelSwitcher } from './ModelSwitcher';

const logger = createLogger('ModelSlot');

export function ModelSlot({ currentModel }: { currentModel: string }) {
  const settingsLoaded = useAppStore((state) => state.settingsLoaded);
  const [retrying, setRetrying] = useState(false);
  const { t } = useI18n();
  const retry = async () => {
    setRetrying(true);
    try { await loadModelSettings(); }
    catch (error) { logger.error('Failed to reload model settings', error); }
    finally { setRetrying(false); }
  };
  if (!settingsLoaded) {
    return <div className="flex items-center gap-2">
      <span role="status" className="text-xs text-zinc-500" data-testid="model-loading">{t.sidebar.modelLoading}</span>
      <Button variant="ghost" size="sm" disabled={retrying} onClick={() => void retry()}>{t.sidebar.connectionRetry}</Button>
    </div>;
  }
  return <ModelSwitcher currentModel={currentModel} />;
}
