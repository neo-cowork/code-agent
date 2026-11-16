// ============================================================================
// 会前提醒：日历上的会快开始时提醒「记这场会」（N-MEETING-CALENDAR-REMINDER）
//
// 授权状态与日程都走原生桥的 EventKit（ADR-090 perm_calendars）：不打开「日历」app、主机不起任何 AppleScript 子进程、
// 巡检永不弹框（弹框只在设置开关的点击里，经 envAssist 统一出口）。
// 只提醒，绝不自动开录：自动拉起 ScreenCaptureKit 会被 macOS 标成屏幕共享。
// ============================================================================

import { MEETING_SESSION_LIMITS } from '../../../shared/constants';
import type { MeetingUpcoming } from '../../../shared/contract/audioCapture';

export interface CalendarReminderDeps {
  enabled: () => boolean | Promise<boolean>;
  /** 被动读授权（不弹框），完全访问才读日程 */
  granted: () => Promise<boolean>;
  upcoming: (fromMs: number, toMs: number) => Promise<MeetingUpcoming[]>;
  isMeetingActive: () => boolean;
  notify: (event: MeetingUpcoming) => void;
  now?: () => number;
}

/** 每分钟看一次：会开始前 LEAD 内提醒一次（同一场只提醒一次），已在记录就不提醒 */
export class MeetingCalendarReminder {
  private reminded = new Set<string>();
  private current: MeetingUpcoming | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: CalendarReminderDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, MEETING_SESSION_LIMITS.CALENDAR_POLL_MS);
    this.timer.unref?.(); // 不因为这个巡检拖住进程退出
  }

  /** 录制条上显示的「XX 快开始了」：开关关了立刻不挂；开始后过了 LEAD 也不再挂着 */
  async upcoming(): Promise<MeetingUpcoming | null> {
    const cur = this.current;
    if (!cur || this.deps.isMeetingActive()) return null;
    if (!(await this.deps.enabled())) {
      this.current = null;
      return null;
    }
    return this.now() - cur.startAtMs < MEETING_SESSION_LIMITS.CALENDAR_LEAD_MS ? cur : null;
  }

  dismiss(): void {
    this.current = null;
  }

  async tick(): Promise<void> {
    if (this.deps.isMeetingActive() || !(await this.deps.enabled())) return;
    try {
      if (!(await this.deps.granted())) return;
      const now = this.now();
      const events = await this.deps.upcoming(now, now + MEETING_SESSION_LIMITS.CALENDAR_LEAD_MS);
      for (const e of events) {
        if (this.reminded.has(e.id)) continue;
        this.reminded.add(e.id);
        this.current = e;
        this.deps.notify(e);
        break; // 同时有几场只提醒最早那场（原生层已按开始时间排好）
      }
    } catch {
      // 读日历失败（授权被收回、桥不可达）：这一轮不提醒，下一分钟再试
    }
  }
}
