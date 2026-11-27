import React, { useEffect, useState } from 'react';
import type { EnvAssistNotice, EnvAssistActRequest, EnvAssistActResult } from '@shared/contract/envAssist';
import { IPC_DOMAINS } from '@shared/ipc';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { invokeDomain } from '../../../services/ipcService';
import { useEnvAssistStore } from '../../../stores/envAssistStore';
import { useEnvCardResumesAutomatically } from '../../../hooks/useEnvParkedTarget';

function lookupKey(catalogue: Record<string, string>, fullKey: string | undefined, prefix: string): string {
  if (!fullKey?.startsWith(prefix)) return '';
  const entry = fullKey.slice(prefix.length);
  return Object.hasOwn(catalogue, entry) ? catalogue[entry] : '';
}

function formatPercent(notice: EnvAssistNotice): string {
  const raw = typeof notice.sentenceParams?.percent === 'number'
    ? notice.sentenceParams.percent
    : notice.progress?.percent;
  const clamped = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 0;
  return String(clamped);
}

export function EnvAssistCard({ notice: snapshot }: { notice: EnvAssistNotice }): React.ReactElement {
  const { t } = useI18n();
  const live = useEnvAssistStore((state) => state.notices[snapshot.id]);
  const notice = live && live.updatedAt >= snapshot.updatedAt ? live : snapshot;
  const isRuntime = notice.class === 'runtime_missing';
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
  // A runtime card still "preparing" passively re-syncs on mount/focus so a reload or tab return cannot leave it stale.
  // The host persists + broadcasts the updated notice; this card only re-reads through the store.
  const canShowButton = (isRuntime || available) && notice.phase === 'needs_user' && Boolean(notice.action);
  const shouldRecheck = isRuntime
    ? notice.phase === 'fixing'
    : (available && notice.phase === 'needs_user' && Boolean(notice.action));
  useEffect(() => {
    if (!shouldRecheck) return;
    // The host also returns the updated copy, so a broadcast missed while another page was open can't leave the card stale.
    const recheck = () => {
      void invokeDomain<EnvAssistActResult>(IPC_DOMAINS.ENV_ASSIST, 'recheck', { noticeId: notice.id })
        .then((result) => { if (result?.notice) useEnvAssistStore.getState().report(result.notice); })
        .catch(() => undefined);
    };
    recheck();
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, [shouldRecheck, notice.id]);
  // Resolve only our own copy catalogue. Arbitrary host strings/params never become visible copy.
  const rawSentence = notice.phase === 'resolved'
    ? lookupKey(t.env.done, notice.doneKey, 'env.done.')
    : lookupKey(t.env.sentence, notice.sentenceKey, 'env.sentence.');
  const sentence = rawSentence.includes('{percent}') ? rawSentence.replace('{percent}', formatPercent(notice)) : rawSentence;
  // 停车等授权/等组件准备的那一轮：就绪后同一任务自动续做，卡上一并说清（输入框上方不再另起一行重复）。
  const parked = useEnvCardResumesAutomatically(notice) && Boolean(sentence);
  const autoResumeSuffix = !parked
    ? ''
    : isRuntime
      ? (notice.phase === 'fixing' ? t.env.autoResumeRuntime : '')
      : (notice.phase !== 'resolved' ? t.env.autoResume : '');
  const label = lookupKey(t.env.allow, notice.action?.labelKey, 'env.allow.')
    || lookupKey(t.env.retry, notice.action?.labelKey, 'env.retry.');
  const act = async () => {
    if (!notice.action || busy) return;
    setBusy(true);
    try {
      const request: EnvAssistActRequest = { noticeId: notice.id, actionKind: notice.action.kind, payload: notice.action.payload };
      const result = await invokeDomain<EnvAssistActResult>(IPC_DOMAINS.ENV_ASSIST, 'act', request);
      if (result.notice) useEnvAssistStore.getState().report(result.notice);
      if (!isRuntime && result.status !== 'opened') setAvailable(false);
    } catch { if (!isRuntime) setAvailable(false); }
    finally { setBusy(false); }
  };
  return (
    <div data-testid="env-assist-card" data-notice-id={notice.id} className="my-2 rounded-lg border border-border-strong bg-void p-3 text-sm text-text-primary">
      <p>{autoResumeSuffix ? `${sentence}${autoResumeSuffix}` : sentence}</p>
      {notice.progress && <progress className="mt-2 w-full" max={100} value={notice.progress.percent} />}
      {canShowButton && label && (
        <Button className="mt-2" size="sm" variant="secondary" disabled={busy} onClick={() => void act()}>{label}</Button>
      )}
    </div>
  );
}
