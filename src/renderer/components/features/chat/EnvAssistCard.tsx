import React, { useEffect, useState } from 'react';
import type { EnvAssistNotice, EnvAssistActRequest, EnvAssistActResult } from '@shared/contract/envAssist';
import { IPC_DOMAINS } from '@shared/ipc';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { invokeDomain } from '../../../services/ipcService';
import { useEnvAssistStore } from '../../../stores/envAssistStore';
import { useEnvCardResumesAutomatically } from '../../../hooks/useEnvParkedTarget';

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
  // A grant made in System Settings (not via the button) is picked up on mount and whenever the user comes back to Neo.
  // The host persists + broadcasts the resolved notice; this card only re-reads through the store.
  const waiting = available && notice.phase === 'needs_user' && Boolean(notice.action);
  useEffect(() => {
    if (!waiting) return;
    const recheck = () => { void invokeDomain(IPC_DOMAINS.ENV_ASSIST, 'recheck', { noticeId: notice.id }).catch(() => undefined); };
    recheck();
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, [waiting, notice.id]);
  // Resolve only our own copy catalogue. Arbitrary host strings/params never become visible copy.
  const target = notice.target?.id as keyof typeof t.env.sentence;
  const known = Object.hasOwn(t.env.sentence, target);
  const sentence = notice.phase === 'resolved'
    ? (known && notice.doneKey === `env.done.${target}` ? t.env.done[target] : '')
    : known && notice.sentenceKey === `env.sentence.${target}` ? t.env.sentence[target] : '';
  // 停车等授权的那一轮：允许后同一任务自动续做，卡上一并说清（输入框上方不再另起一行重复）。
  const autoResumes = useEnvCardResumesAutomatically(notice) && notice.phase !== 'resolved' && Boolean(sentence);
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
      <p>{autoResumes ? `${sentence}${t.env.autoResume}` : sentence}</p>
      {notice.progress && <progress className="mt-2 w-full" max={100} value={notice.progress.percent} />}
      {waiting && label && (
        <Button className="mt-2" size="sm" variant="secondary" disabled={busy} onClick={() => void act()}>{label}</Button>
      )}
    </div>
  );
}
