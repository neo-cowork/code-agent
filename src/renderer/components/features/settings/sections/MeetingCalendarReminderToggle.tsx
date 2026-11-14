// 「会前提醒我记这场会」开关（N-MEETING-SESSION）：默认关；打开时才请求系统日历授权。
// 只提醒，不自动开录（自动拉起系统音频采集会被 macOS 标成屏幕共享）。

import React, { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import type { AppSettings } from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { requestCalendarAccess } from '../../../../services/nativeDesktop';
import { useI18n } from '../../../../hooks/useI18n';
import { Toggle } from '../../../primitives/Toggle';

const save = (on: boolean) =>
  ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', { meeting: { calendarReminder: on } } as Partial<AppSettings>);

export const MeetingCalendarReminderToggle: React.FC = () => {
  const { t } = useI18n();
  const text = t.meetingBar;
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    void ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((s) => setOn(s?.meeting?.calendarReminder === true))
      .catch(() => undefined);
  }, []);

  const handleChange = async (next: boolean) => {
    setBusy(true);
    setDenied(false);
    try {
      await save(next);
      setOn(next);
      if (!next) return;
      // 先存开关再要授权：授权一通过，主进程马上看一眼日历
      const { access } = await requestCalendarAccess();
      if (access !== 'granted') {
        await save(false);
        setOn(false);
        setDenied(true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-lg border border-zinc-700/60 bg-zinc-900 px-3 py-2.5" data-testid="meeting-calendar-reminder">
      <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-200">{text.calendarToggleLabel}</div>
        <div className="text-xs text-zinc-500">{denied ? text.calendarDenied : text.calendarToggleHint}</div>
      </div>
      <Toggle checked={on} onChange={(v) => void handleChange(v)} disabled={busy} aria-label={text.calendarToggleLabel} />
    </div>
  );
};
