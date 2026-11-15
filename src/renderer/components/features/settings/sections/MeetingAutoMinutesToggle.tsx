// ============================================================================
// MeetingAutoMinutesToggle —「散会后自动出纪要」开关（N-MEETING-PAGE）
// 读写 settings.meeting.autoMinutes，缺省视为开；每场会调一次模型，所以提示里写明会产生费用。
// 独立成组件：NativeDesktopSection 已超 1000 行。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc/domains';
import type { AppSettings } from '@shared/contract';
import { Toggle } from '../../../primitives';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';

export const MeetingAutoMinutesToggle: React.FC = () => {
  const { t } = useI18n();
  const copy = t.settings.meeting.autoMinutes;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => { if (!cancelled) setEnabled(settings?.meeting?.autoMinutes !== false); })
      .catch(() => { if (!cancelled) setEnabled(true); });
    return () => { cancelled = true; };
  }, []);

  const handleToggle = async (next: boolean) => {
    if (saving) return;
    setError(null);
    setSaving(true);
    const previous = enabled;
    setEnabled(next);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', { meeting: { autoMinutes: next } });
    } catch {
      setEnabled(previous);
      setError(copy.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 border-b border-zinc-800/50 px-5 py-2 shrink-0" data-testid="meeting-auto-minutes">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-zinc-300">{copy.toggleLabel}</span>
        <Toggle
          checked={enabled === true}
          onChange={handleToggle}
          disabled={enabled === null || saving}
          aria-label={copy.toggleLabel}
        />
      </div>
      <p className="text-[11px] text-zinc-500">{enabled === false ? copy.hintOff : copy.hintOn}</p>
      {error && <p className="text-[11px] text-badge-warning">{error}</p>}
    </div>
  );
};
