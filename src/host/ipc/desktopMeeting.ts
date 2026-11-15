// ============================================================================
// desktop 域的会议动作（N-MEETING-SESSION / N-MEETING-PAGE）：记这场会、会议页、会前提醒
// 从 desktop.ipc.ts 拆出（防止该文件超 1000 行上限）。录音开关仍归 desktop.ipc 管，经参数传进来。
// ============================================================================

import { execFileSync } from 'node:child_process';
import type { IPCResponse } from '@shared/ipc';
import type { MeetingImportCandidate, MeetingSessionStatus } from '@shared/contract/audioCapture';
import { getAudioCaptureStatus, getSqlitePath } from '../services/desktop/desktopAudioCapture';
import { MeetingSession, createSqliteMeetingStore } from '../services/desktop/meetingSession';
import { MeetingCalendarReminder } from '../services/desktop/meetingCalendar';
import { calendarAccess } from '../permissions/envAssist/probes/passiveProbes';
import { createShellPassiveBridge } from '../permissions/envAssist/probes/shellPassiveBridge';
import { createCalendarEventsReader } from '../permissions/envAssist/calendarEvents';
import { resolveShellBridgeClientFromEnv } from '../permissions/envAssist/shellBridge/client';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DesktopMeetingIPC');

type Handler = (service: unknown, raw: unknown) => Promise<IPCResponse<unknown>>;

export interface MeetingAudioControl {
  /** 按会议模式开录音（不是会议模式就先停再开）；失败原样返回 AUDIO_START_FAILED */
  startMeetingCapture: (service: unknown) => Promise<IPCResponse<unknown>>;
  stopManualAudio: () => void;
}

/** 会前提醒：只在有原生桥（桌面壳）时巡检；授权与日程都走 EventKit，不弹框、不打开「日历」app */
function createReminder(isMeetingActive: () => boolean): MeetingCalendarReminder | null {
  const client = process.platform === 'darwin' ? resolveShellBridgeClientFromEnv() : null;
  if (!client) return null;
  const passive = createShellPassiveBridge(client);
  return new MeetingCalendarReminder({
    enabled: async () => {
      try {
        const { getConfigService } = await import('../services/core/configService');
        return getConfigService().getSettings().meeting?.calendarReminder === true;
      } catch {
        return false;
      }
    },
    granted: async () => (await calendarAccess(passive)) === 'granted',
    upcoming: createCalendarEventsReader(client),
    isMeetingActive,
    // 只提醒，绝不自动开录（会被标成屏幕共享）
    notify: (event) => {
      void import('../services/infra/notificationService')
        .then(({ notificationService }) => notificationService.notifyMeetingStarting({
          title: `「${event.title || '日历上的会'}」快开始了`,
          body: '要记这场会吗？打开 Neo，在输入框上方点「记这场会」。记得先征得参会人同意。',
        }))
        .catch(() => undefined);
    },
  });
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
    Date.now,
    // 散会自动交记言出纪要（N-MEETING-PAGE）；开关、转写长度在 meetingMinutes 里判，这里只入队
    (record) => {
      void import('../services/desktop/meetingMinutes').then(({ enqueueMeetingMinutes }) => enqueueMeetingMinutes(record.id));
    },
  );

  const reminder = createReminder(() => Boolean(session.status().current));
  reminder?.start();

  /** 会议状态 + 会前提醒（开关关着时 upcoming 恒为空） */
  const status = (): MeetingSessionStatus => ({ ...session.status(), upcoming: reminder?.upcoming() ?? null });
  const ok = (data: unknown): IPCResponse<unknown> => ({ success: true, data });
  const idOf = (raw: unknown) => (typeof (raw as { id?: unknown } | undefined)?.id === 'string' ? (raw as { id: string }).id : '');

  const handlers = {
    startMeeting: async (service: unknown, raw: unknown) => {
      if (!session.status().current) {
        const started = await audio.startMeetingCapture(service);
        if (!started.success) return started; // 缺转写引擎等前置：原样带回界面
      }
      const payload = raw as { title?: unknown } | undefined;
      // 没给标题时用日历上快开始的那场会的名字
      const title = typeof payload?.title === 'string' ? payload.title : reminder?.upcoming()?.title;
      reminder?.dismiss();
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
      reminder?.dismiss();
      return ok(status());
    },
    // 会议页（N-MEETING-PAGE）：列表带纪要状态，详情带整场转写；导入后与本机录的会一样按设置自动出纪要
    listMeetings: async () => {
      session.status(); // 先收尾上次意外退出没走完的会，列表里才不会挂着「记录中」
      const { getMeetingRecordStore } = await import('../services/desktop/meetingRecordsDefault');
      return ok((await getMeetingRecordStore()).list(50));
    },
    getMeetingDetail: async (_service: unknown, raw: unknown) => {
      const id = idOf(raw);
      const { getMeetingRecordStore } = await import('../services/desktop/meetingRecordsDefault');
      const store = await getMeetingRecordStore();
      const meeting = id ? store.get(id) : null;
      if (!meeting) return { success: false, error: { code: 'NOT_FOUND', message: 'meeting not found' } } satisfies IPCResponse<unknown>;
      return ok({ meeting, transcript: store.transcript(meeting) });
    },
    regenerateMeetingMinutes: async (_service: unknown, raw: unknown) => {
      const id = idOf(raw);
      if (!id) return { success: false, error: { code: 'INVALID_ARGS', message: 'id is required' } } satisfies IPCResponse<unknown>;
      const { enqueueMeetingMinutes } = await import('../services/desktop/meetingMinutes');
      enqueueMeetingMinutes(id, true);
      return ok({ queued: true });
    },
    listMeetingImportCandidates: async () => {
      const { listMeetingImportCandidates, defaultImportDeps } = await import('../services/desktop/meetingImport');
      return ok(await listMeetingImportCandidates(await defaultImportDeps()));
    },
    importMeeting: async (_service: unknown, raw: unknown) => {
      const { importMeeting, defaultImportDeps } = await import('../services/desktop/meetingImport');
      const { enqueueMeetingMinutes } = await import('../services/desktop/meetingMinutes');
      const result = await importMeeting(raw as MeetingImportCandidate, await defaultImportDeps());
      if (result.created) enqueueMeetingMinutes(result.id);
      return ok(result);
    },
  } satisfies Record<string, Handler>;

  return {
    handlers,
    /** 设置页关录音时，这场会跟着结束 */
    onCaptureStoppedExternally: () => session.onCaptureStoppedExternally(),
  };
}
