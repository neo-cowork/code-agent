// ============================================================================
// desktop 域的会议动作（N-MEETING-SESSION）：记这场会 + 会前提醒
// 从 desktop.ipc.ts 拆出（该文件超 1000 行上限）。录音开关仍归 desktop.ipc 管，经参数传进来。
// ============================================================================

import { execFileSync } from 'node:child_process';
import type { IPCResponse } from '@shared/ipc';
import type { MeetingSessionStatus } from '@shared/contract/audioCapture';
import { getAudioCaptureStatus, getSqlitePath } from '../services/desktop/desktopAudioCapture';
import { MeetingSession, createSqliteMeetingStore } from '../services/desktop/meetingSession';
import { MeetingCalendarReminder, getCalendarAccess, listUpcomingEvents, requestCalendarAccess } from '../services/desktop/meetingCalendar';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DesktopMeetingIPC');

type Handler = (service: unknown, raw: unknown) => Promise<IPCResponse<unknown>>;

export interface MeetingAudioControl {
  /** 按会议模式开录音（不是会议模式就先停再开）；失败原样返回 AUDIO_START_FAILED */
  startMeetingCapture: (service: unknown) => Promise<IPCResponse<unknown>>;
  stopManualAudio: () => void;
}

export function createMeetingIpc(audio: MeetingAudioControl) {
  // 只由用户手动开始（+ 菜单 / 录制条），录音走会议模式
  const session = new MeetingSession(
    createSqliteMeetingStore(() => getSqlitePath(), (dbPath, sql, json) => {
      try {
        return execFileSync('sqlite3', json ? ['-json', dbPath, sql] : [dbPath, sql], { encoding: 'utf-8' });
      } catch (error) {
        logger.warn('[会议] 读写 meetings 失败', { error: error instanceof Error ? error.message : String(error) });
        return '';
      }
    }),
    {
      start: async () => getAudioCaptureStatus().capturing, // 录音已由 startMeetingCapture 开好，这里只确认
      stop: audio.stopManualAudio,
      isCapturing: () => getAudioCaptureStatus().capturing,
    },
  );

  // 会前提醒：开关打开才读日历；只发通知 + 录制条提示，绝不自动开录（会被标成屏幕共享）。
  // 配置/通知服务用到时再加载，不在加载期拖进整串依赖。
  const reminder = new MeetingCalendarReminder({
    enabled: async () => {
      try {
        const { getConfigService } = await import('../services/core/configService');
        return getConfigService().getSettings().meeting?.calendarReminder === true;
      } catch {
        return false;
      }
    },
    access: getCalendarAccess,
    upcoming: listUpcomingEvents,
    isMeetingActive: () => Boolean(session.status().current),
    notify: (event) => {
      void import('../services/infra/notificationService')
        .then(({ notificationService }) => notificationService.notifyMeetingStarting({
          title: `「${event.title || '日历上的会'}」快开始了`,
          body: '要记这场会吗？打开 Neo，在输入框上方点「记这场会」。记得先征得参会人同意。',
        }))
        .catch(() => undefined);
    },
  });
  if (process.platform === 'darwin') reminder.start();

  /** 会议状态 + 会前提醒（开关关着时 upcoming 恒为空、access 未查过） */
  const status = (): MeetingSessionStatus => ({
    ...session.status(),
    upcoming: reminder.upcoming(),
    calendarAccess: reminder.access ?? undefined,
  });
  const ok = (data: unknown): IPCResponse<unknown> => ({ success: true, data });

  const handlers = {
    startMeeting: async (service: unknown, raw: unknown) => {
      if (!session.status().current) {
        const started = await audio.startMeetingCapture(service);
        if (!started.success) return started; // 缺转写引擎等前置：原样带回界面
      }
      const payload = raw as { title?: unknown } | undefined;
      // 没给标题时用日历上快开始的那场会的名字
      const title = typeof payload?.title === 'string' ? payload.title : reminder.upcoming()?.title;
      reminder.dismiss();
      return ok(await session.start(title));
    },
    pauseMeeting: async () => ok(session.pause()),
    resumeMeeting: async (service: unknown) => {
      if (session.status().current?.state === 'paused') {
        const started = await audio.startMeetingCapture(service);
        if (!started.success) return started;
      }
      return ok(await session.resume());
    },
    stopMeeting: async () => ok(session.end('manual')),
    getMeetingStatus: async () => ok(status()),
    dismissMeetingUpcoming: async () => {
      reminder.dismiss();
      return ok(status());
    },
    /** 用户打开「会前提醒」开关时调：弹系统日历授权框（已授权/已拒绝时不弹，直接返回状态） */
    requestCalendarAccess: async () => {
      const current = await getCalendarAccess();
      const access = current === 'not_determined' ? await requestCalendarAccess() : current;
      reminder.access = access;
      if (access === 'granted') void reminder.tick(); // 刚打开就看一眼，别等一分钟
      return ok({ access });
    },
    listMeetings: async () => ok(session.list()),
  } satisfies Record<string, Handler>;

  return {
    handlers,
    /** 设置页关录音时，这场会跟着结束 */
    onCaptureStoppedExternally: () => session.onCaptureStoppedExternally(),
  };
}
