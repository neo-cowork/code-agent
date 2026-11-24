import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { getServerConnectionStatus } from '../../../stores/serverConnectionStore';
import { getServerReloadHint, retryNow } from '../../../utils/serverConnectionMonitor';
import { Button } from '../../primitives';

export function SettingsLoadFallback({ onClose }: { onClose?: () => void }) {
  const { t } = useI18n();
  return (
    <div role="status" className="space-y-3 text-sm">
      <p>{t.settings.pageLoadFailed}</p>
      <p className="text-zinc-400">{getServerReloadHint(t.serverConnection)}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            // The monitor reloads on recovery. Keep the hint visible while the probe is failing.
            if (getServerConnectionStatus() !== 'ok') {
              retryNow();
            } else {
              window.location.reload();
            }
          }}
        >
          {t.settings.reloadPage}
        </Button>
        {onClose && <Button size="sm" variant="ghost" onClick={onClose}>{t.common.close}</Button>}
      </div>
    </div>
  );
}
