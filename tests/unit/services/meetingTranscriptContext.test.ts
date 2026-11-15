import { describe, expect, it } from 'vitest';
import { buildActivityContext, buildMeetingTranscript } from '../../../src/host/services/activity/activityContextProvider';
import { MEETING_SESSION_LIMITS as L } from '../../../src/shared/constants';
import type { AudioSegment } from '../../../src/shared/contract';

const NOW = new Date(2026, 10, 14, 15, 30).getTime();
const MIN = 60_000;

function seg(minAgo: number, transcript: string, speaker: number | null): AudioSegment {
  const start = NOW - minAgo * MIN;
  return { id: `a-${minAgo}`, start_at_ms: start, end_at_ms: start + 3000, duration_ms: 3000, wav_path: '/tmp/a.wav', transcript, speaker_id: speaker, asr_engine: 'test' };
}

function service(meeting: { title: string; started_at_ms: number; ended_at_ms: number | null } | null, segments: AudioSegment[]) {
  const ranges: Array<[number, number]> = [];
  return {
    ranges,
    getCurrentContext: () => null,
    listRecent: () => [],
    listAudioSegments: (from: number, to: number) => { ranges.push([from, to]); return segments.filter((s) => s.start_at_ms >= from && s.start_at_ms < to); },
    getLatestMeeting: () => meeting,
    listRecentAudioSegments: (from: number, to: number) => segments.filter((s) => s.start_at_ms >= from && s.start_at_ms < to),
  };
}

const deps = (svc: ReturnType<typeof service>) => ({ nowMs: () => NOW, nativeDesktopService: svc, openchronicleContextFetcher: async () => null });

describe('对话按场取转写（N-MEETING-SESSION 验收⑤）', () => {
  it('进行中的会：取这场会从开始到现在的转写（不止最近 1 小时），标出我/对方与时刻', () => {
    const svc = service({ title: '产品周会', started_at_ms: NOW - 90 * MIN, ended_at_ms: null }, [
      seg(120, '会前闲聊，不该进来', 1),
      seg(85, '先过一下卡券对账', 2),
      seg(10, '下周三前对齐口径', 1),
    ]);
    const m = buildMeetingTranscript(deps(svc));
    expect(m?.title).toBe('产品周会');
    expect(m?.text).toBe('[14:05 对方] 先过一下卡券对账\n[15:20 我] 下周三前对齐口径');
  });

  it('有相关的会时，桌面活动里不再重复放最近 1 小时的录音', async () => {
    const svc = service({ title: '产品周会', started_at_ms: NOW - 30 * MIN, ended_at_ms: null }, [seg(10, '下周三前对齐口径', 1)]);
    const ctx = await buildActivityContext(deps(svc));
    expect(ctx.sources.find((s) => s.source === 'audio')?.status).toBe('unavailable');
    expect(svc.ranges).toHaveLength(0);
  });

  it('会刚结束：会内的按场注入，会后录的仍放进桌面活动（只取结束之后的）', async () => {
    const svc = service({ title: '产品周会', started_at_ms: NOW - 60 * MIN, ended_at_ms: NOW - 40 * MIN }, [
      seg(50, '会上说的', 2),
      seg(10, '会后自己录的备忘', 1),
    ]);
    expect(buildMeetingTranscript(deps(svc))?.text).toBe('[14:40 对方] 会上说的');
    const ctx = await buildActivityContext(deps(svc));
    const audio = ctx.sources.find((s) => s.source === 'audio');
    expect(audio?.status).toBe('available');
    expect(audio?.text).toContain('会后自己录的备忘');
    expect(audio?.text).not.toContain('会上说的');
  });

  it('会结束超过 2 小时：不注入会议转写，录音回到最近 1 小时的老逻辑', async () => {
    const svc = service({ title: '早会', started_at_ms: NOW - 4 * 60 * MIN, ended_at_ms: NOW - L.CONTEXT_RECENT_MS - MIN }, [seg(10, '最近说的话', null)]);
    expect(buildMeetingTranscript(deps(svc))).toBeNull();
    const ctx = await buildActivityContext(deps(svc));
    expect(ctx.sources.find((s) => s.source === 'audio')?.status).toBe('available');
  });

  it('会很长：保留最近的部分，开头标明省略', () => {
    const segments = Array.from({ length: 400 }, (_, i) => seg(200 - i * 0.5, `第${i}句`.padEnd(40, '。'), 2));
    const svc = service({ title: '长会', started_at_ms: NOW - 210 * MIN, ended_at_ms: null }, segments);
    const m = buildMeetingTranscript(deps(svc));
    expect(m!.text.length).toBeLessThanOrEqual(L.CONTEXT_MAX_CHARS + 20);
    expect(m!.text.startsWith('...(更早的部分已省略)')).toBe(true);
    expect(m!.text).toContain('第399句');
    expect(m!.text).not.toContain('第0句');
  });

  it('没有开过会（没有 meetings 表）：不注入，行为同以前', () => {
    expect(buildMeetingTranscript(deps(service(null, [seg(10, 'x', 1)])))).toBeNull();
  });
});
