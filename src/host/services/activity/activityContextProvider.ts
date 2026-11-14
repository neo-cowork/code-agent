import type {
  ActivityContext,
  ActivityContextItem,
  ActivityContextSource,
  ActivityEvidenceRef,
  AudioSegment,
  DesktopActivityEvent,
} from '@shared/contract';
import { fetchOpenchronicleContext } from '../external/openchronicleContextProvider';
import { getNativeDesktopService } from '../desktop/nativeDesktopService';
import { guardSensitiveText } from '../../security/sensitiveDataGuard';
import { AUDIO_SPEAKER_ID } from '@shared/contract/audioCapture';
import { MEETING_SESSION_LIMITS } from '@shared/constants';

const DEFAULT_MAX_CHARS = 12_000;
const OPENCHRONICLE_MAX_CHARS = 3_000;
const NATIVE_DESKTOP_MAX_CHARS = 4_000;
const AUDIO_MAX_CHARS = 3_000;
const SCREENSHOT_ANALYSIS_MAX_CHARS = 2_000;
const RECENT_EVENT_LIMIT = 20;
const AUDIO_LOOKBACK_MS = 60 * 60 * 1000;

interface NativeDesktopActivityReader {
  getCurrentContext(): DesktopActivityEvent | null;
  listRecent(limit?: number): DesktopActivityEvent[];
  listAudioSegments(from: number, to: number): AudioSegment[];
  /** 「记这场会」的最近一场会（没有 meetings 表时为 null） */
  getLatestMeeting?(): { title: string; started_at_ms: number; ended_at_ms: number | null } | null;
  listRecentAudioSegments?(from: number, to: number, limit: number): AudioSegment[];
}

export interface BuildActivityContextDeps {
  nowMs?: () => number;
  maxChars?: number;
  openchronicleContextFetcher?: () => Promise<string | null>;
  nativeDesktopService?: NativeDesktopActivityReader;
}

export async function getCurrentActivityContext(): Promise<ActivityContext> {
  return buildActivityContext();
}

export async function buildActivityContext(deps: BuildActivityContextDeps = {}): Promise<ActivityContext> {
  const now = deps.nowMs?.() ?? Date.now();
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;
  const nativeDesktop = deps.nativeDesktopService ?? getNativeDesktopService();

  const openchronicleSource = await buildOpenchronicleSource({
    now,
    fetcher: deps.openchronicleContextFetcher ?? fetchOpenchronicleContext,
  });

  const { nativeDesktopSource, recentEvents } = buildNativeDesktopSource({
    now,
    service: nativeDesktop,
  });

  const audioSource = buildAudioSource({
    now,
    service: nativeDesktop,
  });

  const screenshotAnalysisSource = buildScreenshotAnalysisSource({
    now,
    recentEvents,
  });

  const sources = [
    openchronicleSource,
    nativeDesktopSource,
    audioSource,
    screenshotAnalysisSource,
  ];

  return {
    generatedAtMs: now,
    maxChars,
    tokenBudgetHint: {
      maxChars,
      targetTokens: Math.ceil(maxChars / 4),
    },
    sources,
    evidenceRefs: sources.flatMap((source) => source.evidenceRefs),
  };
}

async function buildOpenchronicleSource(args: {
  now: number;
  fetcher: () => Promise<string | null>;
}): Promise<ActivityContextSource> {
  try {
    const text = await args.fetcher();
    if (!text?.trim()) {
      return unavailableSource('openchronicle', args.now, OPENCHRONICLE_MAX_CHARS, 'OpenChronicle context is empty or disabled');
    }

    const evidenceRef: ActivityEvidenceRef = {
      source: 'openchronicle',
      kind: 'openchronicle-context',
      id: `openchronicle:${args.now}`,
      label: 'OpenChronicle current_context',
      capturedAtMs: args.now,
    };

    return {
      source: 'openchronicle',
      status: 'available',
      confidence: 0.72,
      privacy: 'redacted',
      generatedAtMs: args.now,
      maxChars: OPENCHRONICLE_MAX_CHARS,
      text: trimToMaxChars(guardActivityText(text), OPENCHRONICLE_MAX_CHARS),
      evidenceRefs: [evidenceRef],
    };
  } catch (error) {
    return unavailableSource(
      'openchronicle',
      args.now,
      OPENCHRONICLE_MAX_CHARS,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function buildNativeDesktopSource(args: {
  now: number;
  service: NativeDesktopActivityReader;
}): { nativeDesktopSource: ActivityContextSource; recentEvents: DesktopActivityEvent[] } {
  try {
    const current = args.service.getCurrentContext();
    const recentEvents = args.service.listRecent(RECENT_EVENT_LIMIT);
    const uniqueEvents = uniqueDesktopEvents([current, ...recentEvents].filter(Boolean) as DesktopActivityEvent[]);
    const items = uniqueEvents.map(toDesktopActivityItem);
    const evidenceRefs = items.flatMap((item) => item.evidenceRefs ?? []);

    if (items.length === 0) {
      return {
        nativeDesktopSource: unavailableSource('tauri-native-desktop', args.now, NATIVE_DESKTOP_MAX_CHARS, 'No native desktop activity events available'),
        recentEvents,
      };
    }

    return {
      nativeDesktopSource: {
        source: 'tauri-native-desktop',
        status: 'available',
        confidence: current ? 0.82 : 0.64,
        privacy: 'redacted',
        generatedAtMs: args.now,
        maxChars: NATIVE_DESKTOP_MAX_CHARS,
        text: trimToMaxChars(items.map(formatDesktopItem).filter(Boolean).join('\n'), NATIVE_DESKTOP_MAX_CHARS),
        items,
        evidenceRefs,
      },
      recentEvents,
    };
  } catch (error) {
    return {
      nativeDesktopSource: unavailableSource(
        'tauri-native-desktop',
        args.now,
        NATIVE_DESKTOP_MAX_CHARS,
        error instanceof Error ? error.message : String(error),
      ),
      recentEvents: [],
    };
  }
}

function buildAudioSource(args: {
  now: number;
  service: NativeDesktopActivityReader;
}): ActivityContextSource {
  try {
    // 有相关的会时，会内转写按这场会单独注入（见 buildMeetingTranscript）：会还在开就不重复放；
    // 会已结束只放结束之后录的（会后的录音不属于这场会，两边都不放就丢了）
    const meeting = relevantMeeting(args.service, args.now);
    if (meeting?.ended_at_ms === null) {
      return unavailableSource('audio', args.now, AUDIO_MAX_CHARS, 'Meeting transcript is injected separately');
    }
    const from = Math.max(args.now - AUDIO_LOOKBACK_MS, meeting?.ended_at_ms ?? 0);
    const segments = args.service.listAudioSegments(from, args.now);
    const items = segments.map(toAudioItem);
    const evidenceRefs = items.flatMap((item) => item.evidenceRefs ?? []);

    if (items.length === 0) {
      return unavailableSource('audio', args.now, AUDIO_MAX_CHARS, 'No audio segments found in the last hour');
    }

    return {
      source: 'audio',
      status: 'available',
      confidence: 0.68,
      privacy: 'local-only',
      generatedAtMs: args.now,
      maxChars: AUDIO_MAX_CHARS,
      text: trimToMaxChars(items.map(formatAudioItem).filter(Boolean).join('\n'), AUDIO_MAX_CHARS),
      items,
      evidenceRefs,
    };
  } catch (error) {
    return unavailableSource(
      'audio',
      args.now,
      AUDIO_MAX_CHARS,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** 正在进行，或结束不到 CONTEXT_RECENT_MS 的会 */
function relevantMeeting(service: NativeDesktopActivityReader, now: number) {
  const meeting = service.getLatestMeeting?.();
  if (!meeting) return null;
  if (meeting.ended_at_ms !== null && now - meeting.ended_at_ms > MEETING_SESSION_LIMITS.CONTEXT_RECENT_MS) return null;
  return meeting;
}

const MEETING_SEGMENT_LIMIT = 600; // 4 小时的会大约这个量级；字数预算再从尾部截

/**
 * 对话按场取转写（N-MEETING-SESSION 验收⑤）：正在进行或刚结束的那场会的转写，标出我/对方与时刻。
 * 会长了保留最近的部分（用户问的多半是刚才说的）。没有相关的会返回 null。
 */
export function buildMeetingTranscript(deps: BuildActivityContextDeps = {}): { title: string; text: string } | null {
  const now = deps.nowMs?.() ?? Date.now();
  const service = deps.nativeDesktopService ?? getNativeDesktopService();
  const meeting = relevantMeeting(service, now);
  if (!meeting || !service.listRecentAudioSegments) return null;
  const segments = service.listRecentAudioSegments(meeting.started_at_ms, meeting.ended_at_ms ?? now, MEETING_SEGMENT_LIMIT);
  const lines = segments
    .map((seg) => {
      const who = seg.speaker_id === AUDIO_SPEAKER_ID.ME ? '我' : seg.speaker_id === AUDIO_SPEAKER_ID.OTHERS ? '对方' : '';
      const t = new Date(seg.start_at_ms);
      const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      return guardActivityText(`[${hhmm}${who ? ` ${who}` : ''}] ${seg.transcript ?? ''}`);
    })
    .filter((line) => line.trim());
  if (lines.length === 0) return null;
  // 从尾部往前装，装满预算为止
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length + 1 > MEETING_SESSION_LIMITS.CONTEXT_MAX_CHARS) break;
    kept.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  const head = kept.length < lines.length ? '...(更早的部分已省略)\n' : '';
  return { title: guardActivityText(meeting.title), text: head + kept.join('\n') };
}

function buildScreenshotAnalysisSource(args: {
  now: number;
  recentEvents: DesktopActivityEvent[];
}): ActivityContextSource {
  const screenshotEvents = args.recentEvents.filter((event) => event.screenshotPath || event.analyzeText?.trim());
  const items = screenshotEvents.map(toScreenshotAnalysisItem);
  const evidenceRefs = items.flatMap((item) => item.evidenceRefs ?? []);

  if (items.length === 0) {
    return unavailableSource('screenshot-analysis', args.now, SCREENSHOT_ANALYSIS_MAX_CHARS, 'No recent screenshot analysis available');
  }

  const analyzedCount = screenshotEvents.filter((event) => Boolean(event.analyzeText?.trim())).length;

  return {
    source: 'screenshot-analysis',
    status: 'available',
    confidence: analyzedCount > 0 ? 0.74 : 0.42,
    privacy: 'redacted',
    generatedAtMs: args.now,
    maxChars: SCREENSHOT_ANALYSIS_MAX_CHARS,
    text: trimToMaxChars(items.map(formatScreenshotItem).filter(Boolean).join('\n'), SCREENSHOT_ANALYSIS_MAX_CHARS),
    items,
    evidenceRefs,
  };
}

function toDesktopActivityItem(event: DesktopActivityEvent): ActivityContextItem {
  const evidenceRef: ActivityEvidenceRef = {
    source: 'tauri-native-desktop',
    kind: 'desktop-event',
    id: event.id,
    label: guardActivityOptional(event.windowTitle || event.browserTitle || event.appName),
    capturedAtMs: event.capturedAtMs,
  };

  return {
    id: event.id,
    title: guardActivityOptional(event.windowTitle || event.browserTitle || event.appName),
    appName: guardActivityOptional(event.appName),
    windowTitle: guardActivityOptional(event.windowTitle),
    browserUrl: guardActivityOptional(event.browserUrl),
    screenshotPath: guardActivityOptional(event.screenshotPath),
    capturedAtMs: event.capturedAtMs,
    confidence: 0.8,
    evidenceRefs: [evidenceRef],
    raw: null,
  };
}

function toAudioItem(segment: AudioSegment): ActivityContextItem {
  const evidenceRef: ActivityEvidenceRef = {
    source: 'audio',
    kind: 'audio-segment',
    id: segment.id,
    label: guardActivityOptional(segment.transcript),
    path: guardActivityOptional(segment.wav_path),
    startAtMs: segment.start_at_ms,
    endAtMs: segment.end_at_ms,
  };

  return {
    id: segment.id,
    text: guardActivityOptional(segment.transcript),
    startAtMs: segment.start_at_ms,
    endAtMs: segment.end_at_ms,
    confidence: 0.62,
    evidenceRefs: [evidenceRef],
    raw: null,
  };
}

function toScreenshotAnalysisItem(event: DesktopActivityEvent): ActivityContextItem {
  const evidenceRef: ActivityEvidenceRef = {
    source: 'screenshot-analysis',
    kind: 'screenshot-analysis',
    id: event.id,
    label: guardActivityOptional(event.analyzeText || event.windowTitle || event.appName),
    path: guardActivityOptional(event.screenshotPath),
    capturedAtMs: event.capturedAtMs,
  };

  return {
    id: event.id,
    title: guardActivityOptional(event.windowTitle || event.browserTitle || event.appName),
    text: guardActivityOptional(event.analyzeText),
    appName: guardActivityOptional(event.appName),
    windowTitle: guardActivityOptional(event.windowTitle),
    screenshotPath: guardActivityOptional(event.screenshotPath),
    capturedAtMs: event.capturedAtMs,
    confidence: event.analyzeText?.trim() ? 0.74 : 0.42,
    evidenceRefs: [evidenceRef],
    raw: null,
  };
}

function unavailableSource(
  source: ActivityContextSource['source'],
  generatedAtMs: number,
  maxChars: number,
  unavailableReason: string,
): ActivityContextSource {
  return {
    source,
    status: 'unavailable',
    confidence: 0,
    privacy: source === 'openchronicle' || source === 'tauri-native-desktop' || source === 'screenshot-analysis'
      ? 'redacted'
      : 'local-only',
    generatedAtMs,
    maxChars,
    text: null,
    items: [],
    evidenceRefs: [],
    unavailableReason: guardActivityText(unavailableReason),
  };
}

function uniqueDesktopEvents(events: DesktopActivityEvent[]): DesktopActivityEvent[] {
  const seen = new Set<string>();
  const unique: DesktopActivityEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  return unique;
}

function formatDesktopItem(item: ActivityContextItem): string {
  const parts = [
    item.appName,
    item.windowTitle,
    item.browserUrl,
  ].filter(Boolean);
  return guardActivityText(parts.join(' | '));
}

function formatAudioItem(item: ActivityContextItem): string {
  if (!item.text) return '';
  return guardActivityText(`[${item.startAtMs ?? ''}-${item.endAtMs ?? ''}] ${item.text}`);
}

function formatScreenshotItem(item: ActivityContextItem): string {
  const title = [item.appName, item.windowTitle].filter(Boolean).join(' | ');
  const text = item.text || (item.screenshotPath ? `Screenshot: ${item.screenshotPath}` : '');
  return guardActivityText([title, text].filter(Boolean).join('\n'));
}

function trimToMaxChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 12))}\n...(truncated)`;
}

function guardActivityText(value: unknown): string {
  return guardSensitiveText(value, {
    surface: 'activity',
    mode: 'model-context',
    maxLength: 8_000,
  }).trim();
}

function guardActivityOptional(value: unknown): string | null {
  const guarded = guardActivityText(value);
  return guarded || null;
}
