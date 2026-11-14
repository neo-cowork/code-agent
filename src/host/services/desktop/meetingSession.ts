// ============================================================================
// 「记这场会」：把一段会议模式录音串成一场会（N-MEETING-SESSION）
//
// 一场会 = meetings 表里一行（标题、起止、状态、结束原因）；这场会的转写就是起止时间内的
// audio_segments（段落时间按样本数推算，FU1 之后是准的），不给段落另打会议号。
// 只由用户手动开始——绝不自动拉起 ScreenCaptureKit（desktop.ipc.ts 顶部注释，被标成屏幕共享）。
// 状态机见 docs/architecture/meeting-session.md。
// ============================================================================

import { MEETING_SESSION_LIMITS } from '../../../shared/constants';
import type {
  MeetingEndReason,
  MeetingRecord,
  MeetingSessionStatus,
} from '../../../shared/contract/audioCapture';

export interface MeetingStore {
  save(record: MeetingRecord, updatedAtMs: number): void;
  /** 上次进程没走完的会（记录中/暂停），一律按「中断」收尾 */
  closeInterrupted(): void;
  /** fromMs 之后最后一段有人声的转写的结束时间；没有则 null */
  lastVoiceEndMs(fromMs: number): number | null;
  list(limit: number): MeetingRecord[];
}

export interface MeetingCapture {
  /** 开会议模式录音；失败时抛错或返回 false，原因由调用方（IPC）带给界面 */
  start(): Promise<boolean>;
  stop(): void;
  isCapturing(): boolean;
}

export class MeetingSession {
  private current: MeetingRecord | null = null;
  private lastEnded: MeetingRecord | null = null;
  /** 静音从这里起算：开始/继续的时刻，或最后一段人声的结束 */
  private silenceSinceMs = 0;
  private lastTickMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private recovered = false;

  constructor(
    private readonly store: MeetingStore,
    private readonly capture: MeetingCapture,
    private readonly now: () => number = Date.now,
  ) {}

  private recover(): void {
    if (this.recovered) return;
    this.recovered = true;
    this.store.closeInterrupted();
  }

  async start(title?: string): Promise<MeetingSessionStatus> {
    this.recover();
    if (this.current) return this.status();
    if (!(await this.capture.start())) return this.status();
    const now = this.now();
    this.current = {
      id: `meeting-${now}`,
      title: title?.trim() || defaultTitle(now),
      startedAtMs: now,
      endedAtMs: null,
      state: 'recording',
      endReason: null,
    };
    this.silenceSinceMs = now;
    this.lastTickMs = now;
    this.store.save(this.current, now);
    this.timer = setInterval(() => this.tick(), MEETING_SESSION_LIMITS.TICK_MS);
    return this.status();
  }

  pause(): MeetingSessionStatus {
    if (this.current?.state !== 'recording') return this.status();
    this.capture.stop();
    this.current = { ...this.current, state: 'paused' };
    this.store.save(this.current, this.now());
    return this.status();
  }

  async resume(): Promise<MeetingSessionStatus> {
    if (this.current?.state !== 'paused') return this.status();
    if (!(await this.capture.start())) return this.status();
    const now = this.now();
    this.current = { ...this.current, state: 'recording' };
    this.silenceSinceMs = now; // 暂停期间不算静音
    this.store.save(this.current, now);
    return this.status();
  }

  /** 结束这场会。endedAtMs 缺省为现在；睡眠时用睡前最后一次巡检的时刻 */
  end(reason: MeetingEndReason, endedAtMs: number = this.now()): MeetingSessionStatus {
    if (!this.current) return this.status();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.capture.isCapturing()) this.capture.stop();
    this.lastEnded = { ...this.current, state: 'ended', endedAtMs, endReason: reason };
    this.current = null;
    this.store.save(this.lastEnded, this.now());
    return this.status();
  }

  /** 录音被别处停掉（设置页的开关）时调用：会跟着结束 */
  onCaptureStoppedExternally(): void {
    if (this.current?.state === 'recording') this.end('manual');
  }

  tick(): void {
    const cur = this.current;
    if (!cur) return;
    const now = this.now();
    const gap = now - this.lastTickMs;
    const beforeGap = this.lastTickMs;
    this.lastTickMs = now;
    if (gap > MEETING_SESSION_LIMITS.SLEEP_GAP_MS) {
      this.end('sleep', beforeGap); // 合盖/睡眠：巡检定时器中间断了一大段
      return;
    }
    if (now - cur.startedAtMs >= MEETING_SESSION_LIMITS.MAX_DURATION_MS) {
      this.end('max_duration');
      return;
    }
    if (cur.state !== 'recording') return;
    if (!this.capture.isCapturing()) {
      this.end('capture_stopped');
      return;
    }
    const lastVoice = this.store.lastVoiceEndMs(this.silenceSinceMs);
    if (lastVoice !== null && lastVoice > this.silenceSinceMs) this.silenceSinceMs = lastVoice;
    if (now - this.silenceSinceMs >= MEETING_SESSION_LIMITS.SILENCE_END_MS) {
      this.end('silence');
      return;
    }
    this.store.save(cur, now); // 心跳：进程意外退出时，下次启动按这个时刻收尾
  }

  status(): MeetingSessionStatus {
    this.recover();
    const silenceMs = this.current?.state === 'recording' ? Math.max(0, this.now() - this.silenceSinceMs) : 0;
    return {
      current: this.current,
      silenceMs,
      silenceWarning: silenceMs >= MEETING_SESSION_LIMITS.SILENCE_WARN_MS,
      lastEnded: this.lastEnded,
    };
  }

  list(limit = 50): MeetingRecord[] {
    this.recover();
    return this.store.list(limit);
  }
}

function defaultTitle(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `会议 ${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ============================================================================
// 存储：和 audio_segments 同一个 desktop-activity.sqlite3，同样走 sqlite3 CLI
// ============================================================================

const MEETINGS_DDL = `CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  state TEXT NOT NULL,
  end_reason TEXT,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings (started_at_ms DESC);`;

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

interface MeetingRow {
  id: string;
  title: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  state: MeetingRecord['state'];
  end_reason: MeetingEndReason | null;
}

export function createSqliteMeetingStore(
  getDbPath: () => string | null,
  run: (dbPath: string, sql: string, json?: boolean) => string,
): MeetingStore {
  const exec = (sql: string, json = false): string => {
    const dbPath = getDbPath();
    if (!dbPath) return '';
    return run(dbPath, `${MEETINGS_DDL}\n${sql}`, json).trim();
  };
  return {
    save(r, updatedAtMs) {
      exec(`INSERT OR REPLACE INTO meetings (id, title, started_at_ms, ended_at_ms, state, end_reason, updated_at_ms) VALUES (${q(r.id)}, ${q(r.title)}, ${r.startedAtMs}, ${r.endedAtMs ?? 'NULL'}, ${q(r.state)}, ${r.endReason ? q(r.endReason) : 'NULL'}, ${updatedAtMs});`);
    },
    closeInterrupted() {
      exec(`UPDATE meetings SET state = 'ended', end_reason = 'interrupted', ended_at_ms = updated_at_ms WHERE state != 'ended';`);
    },
    lastVoiceEndMs(fromMs) {
      const out = exec(`SELECT MAX(end_at_ms) AS t FROM audio_segments WHERE end_at_ms > ${Math.trunc(fromMs)} AND transcript IS NOT NULL AND TRIM(transcript) != '';`, true);
      const t = out ? (JSON.parse(out) as Array<{ t: number | null }>)[0]?.t : null;
      return typeof t === 'number' ? t : null;
    },
    list(limit) {
      const out = exec(`SELECT id, title, started_at_ms, ended_at_ms, state, end_reason FROM meetings ORDER BY started_at_ms DESC LIMIT ${Math.trunc(limit)};`, true);
      if (!out) return [];
      return (JSON.parse(out) as MeetingRow[]).map((r) => ({
        id: r.id, title: r.title, startedAtMs: r.started_at_ms, endedAtMs: r.ended_at_ms, state: r.state, endReason: r.end_reason,
      }));
    },
  };
}
