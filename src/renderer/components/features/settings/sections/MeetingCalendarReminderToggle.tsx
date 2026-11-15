// 「会前提醒我记这场会」开关（N-MEETING-CALENDAR-REMINDER）：默认关。
// 打开只发请求（envAssist.enableSettingGrant）：宿主确认日历「完全访问」后自己写开关，渲染层写不了「开」。
// 关掉不需要授权，直接存设置。只提醒，不自动开录（自动拉起系统音频采集会被 macOS 标成屏幕共享）。

import React, { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import type { AppSettings } from '@shared/contract';
import type { CalendarSettingResult } from '@shared/contract/envAssist';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { Toggle } from '../../../primitives/Toggle';

const SETTING = { setting: 'meetingCalendarReminder' } as const;

export const MeetingCalendarReminderToggle: React.FC = () => {
  const { t } = useI18n();
  const text = t.meetingBar;
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<CalendarSettingResult['reason']>();

  // 打开设置页和窗口重新聚焦时被动再看一眼：之前点过开、后来才在系统框里点「允许」的，宿主会补成开
  useEffect(() => {
    let active = true;
    const recheck = () => {
      void ipcService.invokeDomain<CalendarSettingResult>(IPC_DOMAINS.ENV_ASSIST, 'recheckSettingGrant', SETTING)
        .then((r) => {
          if (!active || !r) return;
          setOn(r.on);
          if (r.on) setReason(undefined);
          else if (r.reason) setReason(r.reason);
        })
        .catch(() => undefined);
    };
    recheck();
    window.addEventListener('focus', recheck);
    return () => { active = false; window.removeEventListener('focus', recheck); };
  }, []);

  const handleChange = async (next: boolean) => {
    setBusy(true);
    setReason(undefined);
    try {
      if (!next) {
        await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', { meeting: { calendarReminder: false } } as Partial<AppSettings>);
        setOn(false);
        return;
      }
      const r = await ipcService.invokeDomain<CalendarSettingResult>(IPC_DOMAINS.ENV_ASSIST, 'enableSettingGrant', SETTING);
      setOn(r?.on === true);
      if (!r?.on) setReason(r?.reason ?? 'unavailable');
    } catch {
      setReason('unavailable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-lg border border-zinc-700/60 bg-zinc-900 px-3 py-2.5" data-testid="meeting-calendar-reminder">
      <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-200">{text.calendarToggleLabel}</div>
        <div className="text-xs text-zinc-500">{reason ? text.calendarReason[reason] : text.calendarToggleHint}</div>
      </div>
      <Toggle checked={on} onChange={(v) => void handleChange(v)} disabled={busy} aria-label={text.calendarToggleLabel} />
    </div>
  );
};
