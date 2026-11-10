import React from 'react';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { openCloudCronSettings } from '../../../utils/cronCloudSettingsNavigation';

/** Creation failed before persistence; the caller keeps the filled draft. */
export function CronCloudCreateNotice({ onSwitchLocal, onSettings = openCloudCronSettings }: {
  onSwitchLocal?: () => void;
  onSettings?: () => void;
}) {
  const { t } = useI18n();
  const copy = t.cronCenter.cloudCreate;
  return (
    <div role="alert" data-testid="cron-cloud-create-notice" className="my-3 space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
      <p>{copy.unconfigured}</p>
      <div className="flex flex-wrap gap-2">
        {onSwitchLocal && <Button size="sm" variant="secondary" onClick={onSwitchLocal}>{copy.switchLocal}</Button>}
        <Button size="sm" variant="ghost" onClick={() => onSettings()}>{copy.settings}</Button>
      </div>
    </div>
  );
}
