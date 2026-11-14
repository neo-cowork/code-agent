// ============================================================================
// 「记这场会」状态（N-MEETING-SESSION）：+ 菜单开始，输入框上方录制条显示与操作
// ============================================================================

import { create } from 'zustand';
import type { MeetingSessionStatus } from '@shared/contract/audioCapture';
import {
  getMeetingStatus,
  pauseMeeting,
  resumeMeeting,
  startMeeting,
  stopMeeting,
} from '../services/nativeDesktop';

interface MeetingSessionState {
  status: MeetingSessionStatus | null;
  busy: boolean;
  /** 开始/继续失败：前置缺失码（transcription_engine_missing 等）或 'generic' */
  error: string | null;
  /** 用户已看过的那场结束提示（避免每次刷新又弹一遍） */
  dismissedEndedId: string | null;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  dismiss: () => void;
}

export const useMeetingSessionStore = create<MeetingSessionState>()((set, get) => {
  const run = async (action: () => Promise<MeetingSessionStatus>) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      set({ status: await action() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      set({ error: /^[a-z_]+$/.test(msg) ? msg : 'generic' });
    } finally {
      set({ busy: false });
    }
  };
  return {
    status: null,
    busy: false,
    error: null,
    dismissedEndedId: null,
    refresh: async () => {
      const status = await getMeetingStatus();
      if (status) set({ status });
    },
    start: () => run(() => startMeeting()),
    pause: () => run(pauseMeeting),
    resume: () => run(resumeMeeting),
    // 手动结束不用再提示「已结束」
    stop: () => run(async () => {
      const st = await stopMeeting();
      set({ dismissedEndedId: st.lastEnded?.id ?? null });
      return st;
    }),
    dismiss: () => set((s) => ({ error: null, dismissedEndedId: s.status?.lastEnded?.id ?? s.dismissedEndedId })),
  };
});
