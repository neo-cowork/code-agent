// ============================================================================
// 会前提醒：读 macOS 日历里快开始的会（N-MEETING-SESSION 验收②）
//
// 走 JXA 调 EventKit：不打开「日历」app（AppleScript 的 tell application "Calendar" 会把它拉起来，
// 后台每分钟读一次不能这样）。授权只在用户打开「会前提醒」开关时请求一次。
// 只提醒，绝不自动开录：自动拉起 ScreenCaptureKit 会被 macOS 标成屏幕共享。
// ============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MEETING_SESSION_LIMITS } from '../../../shared/constants';
import type { MeetingUpcoming } from '../../../shared/contract/audioCapture';

const execFileAsync = promisify(execFile);

/** EKAuthorizationStatus：0 未决定 1 受限 2 拒绝 3 完全访问 4 只写（读不到日程） */
export type CalendarAccess = 'granted' | 'denied' | 'not_determined';

function toAccess(status: number): CalendarAccess {
  if (status === 3) return 'granted';
  if (status === 0) return 'not_determined';
  return 'denied';
}

async function runJxa(script: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], { timeout: timeoutMs });
  return stdout.trim();
}

export async function getCalendarAccess(): Promise<CalendarAccess> {
  if (process.platform !== 'darwin') return 'denied';
  const out = await runJxa("ObjC.import('EventKit'); $.EKEventStore.authorizationStatusForEntityType(0);", 10_000);
  return toAccess(Number(out));
}

/** 弹系统授权框（只在用户打开开关时调）。用户点完或超时后返回最终状态 */
export async function requestCalendarAccess(): Promise<CalendarAccess> {
  if (process.platform !== 'darwin') return 'denied';
  const script = `
ObjC.import('EventKit');
const store = $.EKEventStore.alloc.init;
let done = false;
const cb = (granted, err) => { done = true; };
if (store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) store.requestFullAccessToEventsWithCompletion(cb);
else store.requestAccessToEntityTypeCompletion(0, cb);
const deadline = Date.now() + 120000;
while (!done && Date.now() < deadline) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
$.EKEventStore.authorizationStatusForEntityType(0);`;
  return toAccess(Number(await runJxa(script, 130_000)));
}

/** [fromMs, toMs) 内开始的非全天日程 */
export async function listUpcomingEvents(fromMs: number, toMs: number): Promise<MeetingUpcoming[]> {
  const script = `
ObjC.import('EventKit');
const store = $.EKEventStore.alloc.init;
const pred = store.predicateForEventsWithStartDateEndDateCalendars($.NSDate.dateWithTimeIntervalSince1970(${fromMs / 1000}), $.NSDate.dateWithTimeIntervalSince1970(${toMs / 1000}), $());
const evs = store.eventsMatchingPredicate(pred);
const out = [];
for (let i = 0; i < evs.count; i++) {
  const e = evs.objectAtIndex(i);
  const startMs = Math.round(e.startDate.timeIntervalSince1970 * 1000);
  if (!e.allDay && startMs >= ${fromMs} && startMs < ${toMs}) out.push({ title: ObjC.unwrap(e.title) || '', startAtMs: startMs });
}
JSON.stringify(out);`;
  const parsed: unknown = JSON.parse(await runJxa(script, 15_000) || '[]');
  return Array.isArray(parsed) ? parsed as MeetingUpcoming[] : [];
}

export interface CalendarReminderDeps {
  enabled: () => boolean | Promise<boolean>;
  access: () => Promise<CalendarAccess>;
  upcoming: (fromMs: number, toMs: number) => Promise<MeetingUpcoming[]>;
  isMeetingActive: () => boolean;
  notify: (event: MeetingUpcoming) => void;
  now?: () => number;
}

/** 每分钟看一次：会开始前 LEAD 分钟内提醒一次（同一场只提醒一次），已在记录就不提醒 */
export class MeetingCalendarReminder {
  private reminded = new Set<string>();
  private current: MeetingUpcoming | null = null;
  /** 最近一次巡检查到的授权状态（拉状态时直接读，不每次起 osascript） */
  access: CalendarAccess | null = null;
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

  /** 录制条上显示的「XX 快开始了」：开始后过了 LEAD 就不再挂着 */
  upcoming(): MeetingUpcoming | null {
    const cur = this.current;
    if (!cur || this.deps.isMeetingActive()) return null;
    return this.now() - cur.startAtMs < MEETING_SESSION_LIMITS.CALENDAR_LEAD_MS ? cur : null;
  }

  dismiss(): void {
    this.current = null;
  }

  async tick(): Promise<void> {
    if (this.deps.isMeetingActive() || !(await this.deps.enabled())) return;
    try {
      this.access = await this.deps.access();
      if (this.access !== 'granted') return;
      const now = this.now();
      const events = await this.deps.upcoming(now, now + MEETING_SESSION_LIMITS.CALENDAR_LEAD_MS);
      for (const e of events) {
        const key = `${e.startAtMs}|${e.title}`;
        if (this.reminded.has(key)) continue;
        this.reminded.add(key);
        this.current = e;
        this.deps.notify(e);
        break; // 同时有几场只提醒最早那场
      }
    } catch {
      // 读日历失败（权限被收回、osascript 超时）：这一轮不提醒，下一分钟再试
    }
  }
}
