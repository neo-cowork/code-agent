import React, { useEffect, useState } from 'react';
import type { EnvAssistNotice, EnvAssistActRequest, EnvAssistActResult } from '@shared/contract/envAssist';
import { IPC_DOMAINS } from '@shared/ipc';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { invokeDomain } from '../../../services/ipcService';
import { useEnvAssistStore } from '../../../stores/envAssistStore';

export function EnvAssistCard({ notice: snapshot }: { notice: EnvAssistNotice }): React.ReactElement {
  const { t } = useI18n();
  const live = useEnvAssistStore((state) => state.notices[snapshot.id]);
  const notice = live && live.updatedAt >= snapshot.updatedAt ? live : snapshot;
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void invokeDomain<{ available: boolean }>(IPC_DOMAINS.ENV_ASSIST, 'getAvailability')
      .then((result) => { if (active) setAvailable(result.available); })
      .catch(() => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, []);
  // Resolve only our own copy catalogue. Arbitrary host strings/params never become visible copy.
  const target = notice.target?.id as keyof typeof t.env.sentence;
  const known = Object.hasOwn(t.env.sentence, target);
  const sentence = known && notice.sentenceKey === `env.sentence.${target}` ? t.env.sentence[target] : '';
  const label = known && notice.action?.labelKey === `env.allow.${target}` ? t.env.allow[target] : '';
  const act = async () => {
    if (!notice.action || busy) return;
    setBusy(true);
    try {
      const request: EnvAssistActRequest = { noticeId: notice.id, actionKind: notice.action.kind, payload: notice.action.payload };
      const result = await invokeDomain<EnvAssistActResult>(IPC_DOMAINS.ENV_ASSIST, 'act', request);
      if (result.status !== 'opened') setAvailable(false);
    } catch { setAvailable(false); }
    finally { setBusy(false); }
  };
  return (
    <div data-testid="env-assist-card" data-notice-id={notice.id} className="my-2 rounded-lg border border-border-strong bg-void p-3 text-sm text-text-primary">
      <p>{sentence}</p>
      {notice.progress && <progress className="mt-2 w-full" max={100} value={notice.progress.percent} />}
      {available && notice.phase === 'needs_user' && notice.action && label && (
        <Button className="mt-2" size="sm" variant="secondary" disabled={busy} onClick={() => void act()}>{label}</Button>
      )}
    </div>
  );
}
