import React, { useEffect, useState } from 'react';
import { CLI_CONNECTOR_DESCRIPTORS } from '@shared/constants/cliConnectorDescriptors';
import type { EnvAssistNotice, EnvAssistActRequest, EnvAssistActResult } from '@shared/contract/envAssist';
import { IPC_DOMAINS } from '@shared/ipc';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { interpolate } from '../../../i18n/interpolate';
import { invokeDomain } from '../../../services/ipcService';
import { useEnvAssistStore } from '../../../stores/envAssistStore';
import { useEnvCardResumesAutomatically } from '../../../hooks/useEnvParkedTarget';

const SAFE_CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

function resolveLoginTargetName(
  targetId: string | undefined,
  targets: Record<string, string>,
  language: string,
): string {
  if (!targetId) return '';
  if (Object.hasOwn(targets, targetId)) return targets[targetId];
  const cli = CLI_CONNECTOR_DESCRIPTORS.find((item) => item.id === targetId);
  if (cli) return language === 'en' ? cli.displayNameEn : cli.displayName;
  return SAFE_CONNECTOR_ID.test(targetId) ? targetId : '';
}

export function EnvAssistCard({ notice: snapshot }: { notice: EnvAssistNotice }): React.ReactElement {
  const { t, language } = useI18n();
  const live = useEnvAssistStore((state) => state.notices[snapshot.id]);
  const notice = live && live.updatedAt >= snapshot.updatedAt ? live : snapshot;
  const isLogin = notice.class === 'login_expired';
  const [available, setAvailable] = useState(isLogin);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isLogin) { setAvailable(true); return; }
    let active = true;
    void invokeDomain<{ available: boolean }>(IPC_DOMAINS.ENV_ASSIST, 'getAvailability')
      .then((result) => { if (active) setAvailable(result.available); })
      .catch(() => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, [isLogin]);
  // A grant made in System Settings (not via the button) is picked up on mount and whenever the user comes back to Neo.
  // The host persists + broadcasts the resolved notice; this card only re-reads through the store.
  const waiting = isLogin
    ? (notice.phase === 'needs_user' || notice.phase === 'unconfirmed') && Boolean(notice.action)
    : available && notice.phase === 'needs_user' && Boolean(notice.action);
  useEffect(() => {
    if (!waiting) return;
    // The host also returns the resolved copy, so a broadcast missed while another page was open can't leave the card stale.
    const recheck = () => {
      void invokeDomain<EnvAssistActResult>(IPC_DOMAINS.ENV_ASSIST, 'recheck', { noticeId: notice.id })
        .then((result) => { if (result?.notice) useEnvAssistStore.getState().report(result.notice); })
        .catch(() => undefined);
    };
    recheck();
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, [waiting, notice.id]);
  // Resolve only our own copy catalogue. Arbitrary host strings/params never become visible copy.
  const target = notice.target?.id as keyof typeof t.env.sentence;
  const known = !isLogin && Object.hasOwn(t.env.sentence, target);
  const loginName = isLogin ? resolveLoginTargetName(notice.target?.id, t.env.target, language) : '';
  const sentence = isLogin
    ? !loginName
      ? ''
      : notice.phase === 'resolved'
        ? (notice.doneKey === 'env.done.loginExpired' ? interpolate(t.env.login.done, { name: loginName }) : '')
        : notice.phase === 'declined'
          ? (notice.sentenceKey === 'env.sentence.loginSkipped' ? interpolate(t.env.login.skipped, { name: loginName }) : '')
          : busy
            ? interpolate(t.env.login.verifying, { name: loginName })
            : notice.phase === 'unconfirmed'
              ? (notice.sentenceKey === 'env.sentence.loginUnconfirmed' ? interpolate(t.env.login.unconfirmed, { name: loginName }) : '')
              : notice.sentenceKey === 'env.sentence.loginExpired' ? interpolate(t.env.login.expired, { name: loginName }) : ''
    : notice.phase === 'resolved'
      ? (known && notice.doneKey === `env.done.${target}` ? t.env.done[target] : '')
      : known && notice.sentenceKey === `env.sentence.${target}` ? t.env.sentence[target] : '';
  // 停车等授权的那一轮：允许后同一任务自动续做，卡上一并说清（输入框上方不再另起一行重复）。
  const autoResumes = !isLogin && useEnvCardResumesAutomatically(notice) && notice.phase !== 'resolved' && Boolean(sentence);
  const label = isLogin
    ? notice.phase === 'unconfirmed' && notice.action?.labelKey === 'env.retry.loginExpired'
      ? t.env.login.tryAgain
      : notice.action?.labelKey === 'env.allow.loginExpired' ? t.env.login.signInAgain : ''
    : known && notice.action?.labelKey === `env.allow.${target}` ? t.env.allow[target] : '';
  const showSkip = isLogin && notice.phase === 'unconfirmed' && Boolean(loginName);
  const act = async () => {
    if (!notice.action || busy) return;
    setBusy(true);
    try {
      const request: EnvAssistActRequest = { noticeId: notice.id, actionKind: notice.action.kind, payload: notice.action.payload };
      const result = await invokeDomain<EnvAssistActResult>(IPC_DOMAINS.ENV_ASSIST, 'act', request);
      if (result.notice) useEnvAssistStore.getState().report(result.notice);
      if (!isLogin && result.status !== 'opened') setAvailable(false);
    } catch { if (!isLogin) setAvailable(false); }
    finally { setBusy(false); }
  };
  const skip = async () => {
    if (!showSkip || busy || !notice.target?.id) return;
    setBusy(true);
    try {
      const request: EnvAssistActRequest = {
        noticeId: notice.id,
        actionKind: 'skip_step',
        payload: { serverName: notice.target.id },
      };
      const result = await invokeDomain<EnvAssistActResult>(IPC_DOMAINS.ENV_ASSIST, 'act', request);
      if (result.notice) useEnvAssistStore.getState().report(result.notice);
    } catch { /* keep unconfirmed card visible */ }
    finally { setBusy(false); }
  };
  return (
    <div data-testid="env-assist-card" data-notice-id={notice.id} className="my-2 rounded-lg border border-border-strong bg-void p-3 text-sm text-text-primary">
      <p>{autoResumes ? `${sentence}${t.env.autoResume}` : sentence}</p>
      {notice.progress && <progress className="mt-2 w-full" max={100} value={notice.progress.percent} />}
      {waiting && label && (
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act()}>{label}</Button>
          {showSkip && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void skip()}>{t.env.login.skip}</Button>
          )}
        </div>
      )}
    </div>
  );
}
