// ============================================================================
// MeetingBar —「记这场会」录制条（N-MEETING-SESSION）：输入框上方，L3 上下文层，组件自闸。
// 记录中：计时 · 暂停 · 结束；静音到提醒线变提醒文案；自动结束后告诉用户为什么结束。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { CircleStop, Mic, Pause, Play } from 'lucide-react';
import { MEETING_SESSION_LIMITS, RENDERER_POLLING } from '@shared/constants';
import { useMeetingSessionStore } from '../../../../stores/meetingSessionStore';
import { useAppStore } from '../../../../stores/appStore';
import { useI18n } from '../../../../hooks/useI18n';

const MIN = 60_000;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(total % 60)}` : `${pad(m)}:${pad(total % 60)}`;
}

const barButton = 'flex items-center gap-1 rounded-md px-2 py-0.5 hover:bg-white/10 disabled:opacity-50';

export const MeetingBar: React.FC = () => {
  const { t } = useI18n();
  const text = t.meetingBar;
  const { status, busy, error, dismissedEndedId, refresh, start, pause, resume, stop, dismiss, dismissUpcoming } = useMeetingSessionStore();
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const current = status?.current ?? null;
  const [now, setNow] = useState(() => Date.now());

  // 有会在进行时快轮询（静音提醒/自动结束要及时反映），没有时退到慢心跳：会议不一定从 + 菜单开始
  //（Neo 重开后恢复、日历提醒点开始），录制条要能自己发现
  const active = Boolean(current);
  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), active ? RENDERER_POLLING.MEETING_STATUS : RENDERER_POLLING.MAX_BACKOFF);
    return () => clearInterval(poll);
  }, [active, refresh]);
  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [active]);

  if (error) {
    return (
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-badge-warning/30 bg-badge-warning/10 px-3 py-1.5 text-xs text-badge-warning">
          <Mic size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{text.startFailed}</span>
          <button type="button" className={barButton} onClick={() => { dismiss(); openSettingsTab('openchronicle'); }}>{text.openSettings}</button>
          <button type="button" className={barButton} onClick={dismiss}>{text.dismiss}</button>
        </div>
      </div>
    );
  }

  if (!current && status?.upcoming) {
    return (
      <div className="px-3 pb-2" data-testid="meeting-upcoming">
        <div className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-badge-info/30 bg-badge-info/10 px-3 py-1.5 text-xs text-badge-info">
          <Mic size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {text.upcoming.replace('{title}', status.upcoming.title)} · {text.upcomingConsent}
          </span>
          <button type="button" className={barButton} disabled={busy} onClick={() => void start()}>{text.upcomingStart}</button>
          <button type="button" className={barButton} disabled={busy} onClick={() => void dismissUpcoming()}>{text.dismiss}</button>
        </div>
      </div>
    );
  }

  if (!current) {
    const ended = status?.lastEnded;
    if (!ended || ended.id === dismissedEndedId || ended.endReason === 'manual' || !ended.endReason) return null;
    const msg = text.ended[ended.endReason]
      .replace('{minutes}', String(MEETING_SESSION_LIMITS.SILENCE_END_MS / MIN))
      .replace('{hours}', String(MEETING_SESSION_LIMITS.MAX_DURATION_MS / (60 * MIN)));
    return (
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-zinc-600/40 bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-300">
          <Mic size={13} className="shrink-0 text-zinc-400" />
          <span className="min-w-0 flex-1 truncate">{ended.title} · {msg}</span>
          <button type="button" className={barButton} onClick={dismiss}>{text.dismiss}</button>
        </div>
      </div>
    );
  }

  const paused = current.state === 'paused';
  const warn = !paused && status?.silenceWarning;
  const silenceMin = Math.floor((status?.silenceMs ?? 0) / MIN);
  const remainMin = Math.max(1, Math.ceil((MEETING_SESSION_LIMITS.SILENCE_END_MS - (status?.silenceMs ?? 0)) / MIN));
  return (
    <div className="px-3 pb-2" data-testid="meeting-bar">
      <div className={`flex items-center gap-2 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs ${warn ? 'border-badge-warning/30 bg-badge-warning/10 text-badge-warning' : 'border-badge-danger/30 bg-badge-danger/10 text-badge-danger'}`}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${paused ? 'bg-zinc-400' : 'bg-badge-danger animate-pulse'}`} aria-hidden />
        <span className="shrink-0 font-medium">{paused ? text.paused : text.recording} {formatElapsed(now - current.startedAtMs)}</span>
        <span className="min-w-0 flex-1 truncate opacity-80">
          {warn ? text.silenceWarning.replace('{minutes}', String(silenceMin)).replace('{remain}', String(remainMin)) : current.title}
        </span>
        <button type="button" className={barButton} disabled={busy} onClick={() => void (paused ? resume() : pause())}>
          {paused ? <Play size={12} /> : <Pause size={12} />}
          {paused ? text.resume : text.pause}
        </button>
        <button type="button" className={barButton} disabled={busy} onClick={() => void stop()}>
          <CircleStop size={12} />
          {text.stop}
        </button>
      </div>
    </div>
  );
};
