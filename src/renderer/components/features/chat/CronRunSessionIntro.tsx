// ============================================================================
// CronRunSessionIntro — 定时任务运行记录会话的第一气泡上方小标（N-UI-CRON-RUN-RECORD-CLEAR）
// ----------------------------------------------------------------------------
// 原型 role-wake-prototype-v2 屏四的 <p class="kind">定时任务自动运行</p>：
// 一行低饱和度小字，告诉用户这不是他们发的消息，是任务自动跑的。
// ============================================================================

import React from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';

export const CronRunSessionIntro: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { t } = useI18n();
  const label = useSessionStore((state) => {
    if (!sessionId) return null;
    const origin = state.sessions.find((session) => session.id === sessionId)?.origin;
    if (origin?.metadata?.trigger === 'first_wake') return null;
    // 散会后记言出纪要的会话不是定时任务（N-MEETING-PAGE）
    if (origin?.metadata?.trigger === 'meeting_minutes') return 'meeting_minutes';
    const kind = origin?.kind;
    return kind === 'cron' || kind === 'heartbeat' ? 'cron' : null;
  });
  if (!label) return null;
  return (
    <p className="py-1 text-xs text-zinc-500" data-testid="cron-run-intro-label">
      {label === 'meeting_minutes' ? t.library.meetings.minutesSessionLabel : t.cronRunRecord.kindLabel}
    </p>
  );
};
