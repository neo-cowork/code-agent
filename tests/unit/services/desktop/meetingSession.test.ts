import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingSession, type MeetingCapture, type MeetingStore } from '../../../../src/host/services/desktop/meetingSession';
import { MEETING_SESSION_LIMITS as L } from '../../../../src/shared/constants';
import type { MeetingRecord } from '../../../../src/shared/contract/audioCapture';

const MIN = 60_000;

function setup() {
  let voiceEnd: number | null = null;
  const saved: MeetingRecord[] = [];
  const store: MeetingStore = {
    save: (r) => { saved.push(r); },
    closeInterrupted: vi.fn(),
    lastVoiceEndMs: (from) => (voiceEnd !== null && voiceEnd > from ? voiceEnd : null),
    list: () => [],
  };
  let capturing = false;
  const capture: MeetingCapture = {
    start: async () => { capturing = true; return true; },
    stop: () => { capturing = false; },
    isCapturing: () => capturing,
  };
  const session = new MeetingSession(store, capture, () => Date.now());
  /** 按巡检节奏推进（定时器正常触发，不算睡眠） */
  const advance = (ms: number) => vi.advanceTimersByTime(ms);
  return {
    session, store, saved, advance,
    speak: () => { voiceEnd = Date.now(); },
    killCapture: () => { capturing = false; },
    isCapturing: () => capturing,
  };
}

describe('记这场会：状态与自动结束', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 14, 15, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('开始：记录中，默认标题带日期时间，上次没走完的会按中断收尾', async () => {
    const t = setup();
    const st = await t.session.start();
    expect(st.current).toMatchObject({ state: 'recording', title: '会议 11月14日 15:00', endedAtMs: null });
    expect(t.store.closeInterrupted).toHaveBeenCalledTimes(1);
    expect(t.saved.at(-1)?.state).toBe('recording');
  });

  it('10 分钟没人说话提醒，20 分钟自动结束（原因：静音）', async () => {
    const t = setup();
    await t.session.start('周会');
    t.advance(L.SILENCE_WARN_MS);
    expect(t.session.status().silenceWarning).toBe(true);
    expect(t.session.status().current?.state).toBe('recording');
    t.advance(L.SILENCE_END_MS - L.SILENCE_WARN_MS);
    const st = t.session.status();
    expect(st.current).toBeNull();
    expect(st.lastEnded).toMatchObject({ title: '周会', state: 'ended', endReason: 'silence' });
    expect(t.isCapturing()).toBe(false);
  });

  it('有人说话就重新计静音', async () => {
    const t = setup();
    await t.session.start();
    t.advance(15 * MIN);
    t.speak();
    t.advance(15 * MIN); // 距开始 30 分钟，距上次说话 15 分钟
    expect(t.session.status().current?.state).toBe('recording');
    expect(t.session.status().silenceWarning).toBe(true);
  });

  it('暂停期间不算静音，继续后从继续时刻起算', async () => {
    const t = setup();
    await t.session.start();
    t.session.pause();
    expect(t.isCapturing()).toBe(false);
    t.advance(30 * MIN);
    expect(t.session.status().current?.state).toBe('paused');
    await t.session.resume();
    t.advance(L.SILENCE_END_MS - L.TICK_MS);
    expect(t.session.status().current?.state).toBe('recording');
  });

  it('电脑睡眠（巡检断了一大段）：结束这场会，结束时间取睡前', async () => {
    const t = setup();
    await t.session.start();
    t.advance(L.TICK_MS);
    const beforeSleep = Date.now();
    vi.setSystemTime(beforeSleep + 3 * 60 * MIN); // 合盖 3 小时，定时器没跑
    t.session.tick();
    expect(t.session.status().lastEnded).toMatchObject({ endReason: 'sleep', endedAtMs: beforeSleep });
  });

  it('单场到 4 小时上限自动结束（一直有人说话也停）', async () => {
    const t = setup();
    await t.session.start();
    for (let elapsed = 0; elapsed < L.MAX_DURATION_MS; elapsed += 5 * MIN) { t.speak(); t.advance(5 * MIN); }
    expect(t.session.status().lastEnded?.endReason).toBe('max_duration');
  });

  it('录音意外停了：这场会结束（原因：录音停止）', async () => {
    const t = setup();
    await t.session.start();
    t.killCapture();
    t.advance(L.TICK_MS);
    expect(t.session.status().lastEnded?.endReason).toBe('capture_stopped');
  });

  it('设置页关录音：这场会按手动结束', async () => {
    const t = setup();
    await t.session.start();
    t.session.onCaptureStoppedExternally();
    expect(t.session.status().lastEnded?.endReason).toBe('manual');
  });

  it('录音没开起来：不建会', async () => {
    const t = setup();
    const session = new MeetingSession(t.store, { start: async () => false, stop: () => {}, isCapturing: () => false });
    expect((await session.start()).current).toBeNull();
    expect(t.saved).toHaveLength(0);
  });
});
