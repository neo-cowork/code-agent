import React, { useEffect, useState } from 'react';
import type { EnvAssistNotice, EnvAssistActResult } from '@shared/contract/envAssist';
import { IPC_DOMAINS } from '@shared/ipc';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { invokeDomain } from '../../../services/ipcService';
import { useEnvAssistStore } from '../../../stores/envAssistStore';
import { toast } from '../../../hooks/useToast';

export function OfflineEnvAssistCard({ notice }: { notice: EnvAssistNotice }): React.ReactElement {
  const { t } = useI18n();
  const deadline = notice.resume.deadlineAt ?? 0;
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const resolved = notice.phase === 'resolved';
  const timedOut = now >= deadline;
  useEffect(() => {
    if (resolved) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline, resolved]);

  const recheck = async () => {
    setBusy(true);
    try {
      const result = await invokeDomain<EnvAssistActResult>(IPC_DOMAINS.ENV_ASSIST, 'recheckOffline', { noticeId: notice.id });
      if (result.notice) useEnvAssistStore.getState().report(result.notice);
    } catch {
      toast.error(t.env.offline.recheckFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="env-assist-card" data-notice-id={notice.id} className="my-2 rounded-lg border border-border-strong bg-void p-3 text-sm text-text-primary">
      <p role="status">{resolved ? t.env.offline.resolved : timedOut ? t.env.offline.timedOut : t.env.offline.waiting}</p>
      {timedOut && !resolved && (
        <Button className="mt-2" size="sm" variant="secondary" disabled={busy} onClick={() => void recheck()}>{t.env.offline.continue}</Button>
      )}
    </div>
  );
}
