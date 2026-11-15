// ============================================================================
// MeetingPage — 一场会的会议页（N-MEETING-PAGE ①②③）：资料库「会议」视图里打开
//
// 原设置页 MeetingDetailPanel（议题聚类 + 转写 + 说话人）搬到这里，改读 meetings 表的一场会
// （本机录音或导入的妙记 / 腾讯会议），上面加纪要（决策 / 行动项 / 未解问题）与本场产物。
// 行动项原话没说负责人 / 截止的显示「待认领 / 待定」，只列不派；每条一个「交给 Neo」。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ListChecks, Loader2, MessageSquareQuote, RefreshCw, Send } from 'lucide-react';
import { RENDERER_POLLING } from '@shared/constants';
import type { AudioSegment } from '@shared/contract/desktop';
import type { MeetingActionItem, MeetingDetail, MeetingMinutesItem, MeetingSummaryRecord } from '@shared/contract/audioCapture';
import { getMeetingDetail, regenerateMeetingMinutes } from '../../../services/nativeDesktop';
import { useI18n } from '../../../hooks/useI18n';
import { interpolate } from '../../../i18n/interpolate';
import { useSessionStore } from '../../../stores/sessionStore';
import { useAppStore } from '../../../stores/appStore';
import { Button } from '../../primitives/Button';
import { clusterAudioTopics } from '../settings/sections/nativeDesktopActivityModel';
import { startMeetingActionTask } from '../../../utils/startMeetingActionTask';

type Copy = ReturnType<typeof useI18n>['t']['library']['meetings'];

const SPEAKER_COLORS = ['text-sky-300', 'text-amber-300', 'text-emerald-300', 'text-rose-300', 'text-violet-300', 'text-cyan-300'];

export function formatClock(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function sourceLabel(source: MeetingSummaryRecord['source'], copy: Copy): string {
  return source === 'feishu' ? copy.sourceFeishu : source === 'tmeet' ? copy.sourceTmeet : copy.sourceRecorded;
}

function minutesStatusText(meeting: MeetingSummaryRecord, copy: Copy): string | null {
  switch (meeting.minutesState) {
    case 'pending': return copy.minutesPending;
    case 'running': return copy.minutesRunning;
    case 'failed': return copy.minutesFailed;
    case 'skipped': return copy.minutesSkipped;
    case 'done': return null;
    default: return copy.minutesNone;
  }
}

const Quote: React.FC<{ text: string; copy: Copy }> = ({ text, copy }) => (
  <div className="mt-1 flex gap-1.5 text-[11px] leading-relaxed text-zinc-500">
    <MessageSquareQuote className="mt-0.5 h-3 w-3 shrink-0" aria-label={copy.quote} />
    <span>「{text}」</span>
  </div>
);

const ItemList: React.FC<{ title: string; items: MeetingMinutesItem[]; copy: Copy; testId: string }> = ({ title, items, copy, testId }) => (
  <section data-testid={testId}>
    <h3 className="mb-1.5 text-xs font-medium text-zinc-400">{title}</h3>
    {items.length === 0 ? <p className="text-xs text-zinc-600">{copy.none}</p> : (
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li key={i} className="text-[13px] leading-relaxed text-zinc-200">
            {item.text}
            <Quote text={item.quote} copy={copy} />
          </li>
        ))}
      </ul>
    )}
  </section>
);

const ActionItems: React.FC<{ meeting: MeetingSummaryRecord; items: MeetingActionItem[]; copy: Copy }> = ({ meeting, items, copy }) => (
  <section data-testid="meeting-action-items">
    <h3 className="mb-1.5 text-xs font-medium text-zinc-400">{copy.actionItems}</h3>
    {items.length === 0 ? <p className="text-xs text-zinc-600">{copy.none}</p> : (
      <ul className="space-y-2.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] leading-relaxed text-zinc-200">{item.text}</div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {copy.owner}：<span className={item.owner ? 'text-zinc-300' : 'text-zinc-500'}>{item.owner ?? copy.unassigned}</span>
                <span className="mx-2 text-zinc-700">·</span>
                {copy.due}：<span className={item.due ? 'text-zinc-300' : 'text-zinc-500'}>{item.due ?? copy.undecided}</span>
              </div>
              <Quote text={item.quote} copy={copy} />
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="shrink-0"
              data-testid="meeting-hand-to-neo"
              onClick={() => { void startMeetingActionTask(meeting, item); }}
            >
              <Send className="h-3.5 w-3.5" />
              {copy.handToNeo}
            </Button>
          </li>
        ))}
      </ul>
    )}
  </section>
);

export const MeetingPage: React.FC<{ meetingId: string; onBack: () => void }> = ({ meetingId, onBack }) => {
  const { t } = useI18n();
  const copy = t.library.meetings;
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [activeTopic, setActiveTopic] = useState(0);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const load = useCallback(async () => {
    try {
      setDetail(await getMeetingDetail(meetingId));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [meetingId]);

  useEffect(() => { void load(); }, [load]);

  // 出纪要中：定时刷新，纪要出来自动显示
  const busy = detail?.meeting.minutesState === 'pending' || detail?.meeting.minutesState === 'running';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => { void load(); }, RENDERER_POLLING.MEETING_STATUS);
    return () => clearInterval(timer);
  }, [busy, load]);

  const lines = detail?.transcript ?? [];
  // 议题聚类沿用原面板的算法（按 60 秒静默切段）；导入的转写没有时刻时按句序排
  const topics = useMemo(() => {
    const segs: AudioSegment[] = lines.map((l, i) => ({ id: String(i), start_at_ms: l.atMs ?? i * 1000, end_at_ms: l.atMs ?? i * 1000, duration_ms: 0, transcript: l.text }));
    return clusterAudioTopics(segs, { fallback: copy.topics }).map((g) => ({ ...g, firstIndex: Number(g.segments[0]?.id ?? 0) }));
  }, [lines, copy.topics]);
  const speakers = useMemo(() => [...new Set(lines.map((l) => l.speaker).filter(Boolean))], [lines]);
  const speakerColor = (name: string) => SPEAKER_COLORS[speakers.indexOf(name) % SPEAKER_COLORS.length];
  const topicStarts = useMemo(() => new Map(topics.map((tp) => [tp.firstIndex, tp.label])), [topics]);

  const openMinutesSession = async (sessionId: string) => {
    useAppStore.getState().setShowLibraryPanel(false);
    await useSessionStore.getState().switchSession(sessionId);
  };

  const regenerate = async () => {
    await regenerateMeetingMinutes(meetingId);
    await load();
  };

  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center py-16 text-sm text-zinc-500">
        {loadError ? copy.transcriptEmpty : <Loader2 className="h-5 w-5 animate-spin" />}
      </div>
    );
  }

  const { meeting } = detail;
  const { minutesSessionId } = meeting;
  const status = minutesStatusText(meeting, copy);
  const duration = meeting.endedAtMs ? Math.round((meeting.endedAtMs - meeting.startedAtMs) / 60_000) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="meeting-page">
      <div className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-6 py-3">
        <Button type="button" size="sm" variant="ghost" onClick={onBack} data-testid="meeting-page-back" aria-label={copy.back}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-zinc-100">{meeting.title}</h2>
          <div className="text-[11px] text-zinc-500">
            {new Date(meeting.startedAtMs).toLocaleDateString()} {formatClock(meeting.startedAtMs)}
            {meeting.endedAtMs ? ` – ${formatClock(meeting.endedAtMs)}` : ` · ${copy.inProgress}`}
            {duration !== null ? ` · ${interpolate(copy.durationMinutes, { n: duration })}` : ''} · {sourceLabel(meeting.source, copy)}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：议题与说话人 */}
        <aside className="w-[220px] shrink-0 overflow-y-auto border-r border-zinc-800 py-3" aria-label={copy.topics}>
          {speakers.length > 0 && (
            <div className="mb-3 border-b border-zinc-800/60 px-4 pb-3">
              <div className="mb-1.5 text-[10px] text-zinc-500">{copy.speakers}</div>
              {speakers.map((name) => <div key={name} className={`text-[11px] ${speakerColor(name)}`}>{name}</div>)}
            </div>
          )}
          <div className="px-2">
            <div className="mb-1 px-2 text-[10px] text-zinc-500">{copy.topics}</div>
            {topics.map((topic, idx) => (
              <button /* ds-allow:button: 议题列表项，全宽左对齐多行内容+选中态边框，沿用原会议详情面板样式 */
                key={idx}
                type="button"
                onClick={() => { setActiveTopic(idx); lineRefs.current.get(topic.firstIndex)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${activeTopic === idx ? 'border-badge-info/20 bg-cyan-500/10' : 'border-transparent hover:bg-zinc-800/60'}`}
              >
                {lines[topic.firstIndex]?.atMs !== null && <div className="font-mono text-[10px] text-zinc-600">{formatClock(topic.startMs)}</div>}
                <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-zinc-300">{topic.label}</div>
              </button>
            ))}
          </div>
        </aside>

        {/* 右：纪要 + 本场产物 + 转写 */}
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
          <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4" data-testid="meeting-minutes">
            <div className="mb-3 flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-zinc-400" />
              <h2 className="text-sm font-medium text-zinc-100">{copy.minutes}</h2>
              {status && <span className="text-[11px] text-zinc-500" data-testid="meeting-minutes-status">{busy && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}{status}</span>}
              {!busy && (
                <Button type="button" size="sm" variant="ghost" className="ml-auto" title={copy.costHint} data-testid="meeting-regenerate" onClick={() => { void regenerate(); }}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {meeting.minutes ? copy.regenerate : copy.generate}
                </Button>
              )}
            </div>
            {meeting.minutes && (
              <div className="space-y-4">
                <ItemList title={copy.decisions} items={meeting.minutes.decisions} copy={copy} testId="meeting-decisions" />
                <ActionItems meeting={meeting} items={meeting.minutes.actionItems} copy={copy} />
                <ItemList title={copy.openQuestions} items={meeting.minutes.openQuestions} copy={copy} testId="meeting-open-questions" />
              </div>
            )}
          </section>

          <section className="mb-6" data-testid="meeting-outputs">
            <h2 className="mb-2 text-sm font-medium text-zinc-100">{copy.outputs}</h2>
            {minutesSessionId ? (
              <Button type="button" size="sm" variant="ghost" data-testid="meeting-open-minutes-session" onClick={() => { void openMinutesSession(minutesSessionId); }}>
                {copy.openMinutesSession}
              </Button>
            ) : <p className="text-xs text-zinc-600">{copy.noOutputs}</p>}
          </section>

          <section data-testid="meeting-transcript">
            <h2 className="mb-2 text-sm font-medium text-zinc-100">{copy.transcript}</h2>
            {lines.length === 0 ? <p className="text-xs text-zinc-600">{copy.transcriptEmpty}</p> : (
              <div className="space-y-1">
                {lines.map((line, idx) => (
                  <React.Fragment key={idx}>
                    {topicStarts.has(idx) && idx > 0 && (
                      <div className="flex items-center gap-2 pb-2 pt-4">
                        <div className="h-px flex-1 bg-zinc-800" />
                        <span className="shrink-0 text-[10px] text-zinc-500">{topicStarts.get(idx)}</span>
                        <div className="h-px flex-1 bg-zinc-800" />
                      </div>
                    )}
                    <div ref={(el) => { if (el) lineRefs.current.set(idx, el); }} className="flex gap-3 py-1">
                      <span className="w-11 shrink-0 pt-0.5 text-right font-mono text-[11px] text-zinc-600">{formatClock(line.atMs)}</span>
                      <span className={`w-16 shrink-0 truncate pt-0.5 text-[11px] ${line.speaker ? speakerColor(line.speaker) : ''}`} title={line.speaker}>{line.speaker}</span>
                      <span className="text-[13px] leading-relaxed text-zinc-300">{line.text}</span>
                    </div>
                  </React.Fragment>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
