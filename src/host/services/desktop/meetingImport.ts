// ============================================================================
// 导入外部会议转写到会议页（N-MEETING-PAGE ⑤）：飞书妙记 / 腾讯会议录制
//
// 与 tmeetRecord* / feishuMinutes* 工具共用同一套连接器调用和解析（tmeetRecords.ts / feishuMinutes.ts）。
// 导入后和本机录的会一样：成为 meetings 表里的一场会（source=feishu/tmeet），按设置自动出纪要。
// ============================================================================

import type { MeetingImportCandidate, MeetingTranscriptLine } from '../../../shared/contract/audioCapture';
import { createLogger } from '../infra/logger';
import type { MeetingRecordStore } from './meetingRecords';
import { fetchFeishuMinute, minuteTokenOf, parseMinutesSearch, type LarkExec } from '../../tools/modules/connectors/feishuMinutes';
import { fetchTmeetTranscript, type TmeetExec } from '../../tools/modules/connectors/tmeetRecords';

const logger = createLogger('MeetingImport');
const DAY_MS = 24 * 60 * 60 * 1000;
/** 导入对话框列最近多少天的候选 */
const CANDIDATE_LOOKBACK_DAYS = 30;

export interface MeetingImportDeps {
  store: MeetingRecordStore;
  lark: LarkExec;
  tmeet: TmeetExec;
  now?: () => number;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 「开始时间: 2026.11.01 21:07:26 时长: 59 分 36 秒」→ 毫秒（北京时间） */
function feishuStartMs(description: string): number | null {
  const m = /开始时间:\s*(\d{4})\.(\d\d)\.(\d\d) (\d\d:\d\d:\d\d)/.exec(description);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}+08:00`) : null;
}

/** 导入对话框：最近 30 天的妙记和腾讯会议录制。某一家没连接就只返回另一家，并带回原因 */
export async function listMeetingImportCandidates(deps: MeetingImportDeps): Promise<{ candidates: MeetingImportCandidate[]; errors: Partial<Record<'feishu' | 'tmeet', string>> }> {
  const now = deps.now?.() ?? Date.now();
  const startIso = new Date(now - CANDIDATE_LOOKBACK_DAYS * DAY_MS).toISOString();
  const endIso = new Date(now).toISOString();
  const candidates: MeetingImportCandidate[] = [];
  const errors: Partial<Record<'feishu' | 'tmeet', string>> = {};
  const [feishu, tmeet] = await Promise.allSettled([
    deps.lark(['minutes', '+search', '--as', 'user', '--format', 'json', `--start=${startIso}`, `--end=${endIso}`, '--page-size=30'], 'lark-cli minutes +search'),
    deps.tmeet(['record', 'list', `--start=${startIso}`, `--end=${endIso}`, '--format', 'json'], 'tmeet record list'),
  ]);
  if (feishu.status === 'fulfilled') {
    for (const h of parseMinutesSearch(feishu.value).hits) {
      candidates.push({ source: 'feishu', ref: h.token, title: h.title || h.token, startedAtMs: feishuStartMs(h.description) });
    }
  } else {
    errors.feishu = feishu.reason instanceof Error ? feishu.reason.message : String(feishu.reason);
  }
  if (tmeet.status === 'fulfilled') {
    const data = obj(obj(JSON.parse(tmeet.value)).data);
    for (const m of arr(data.record_meetings).map(obj)) {
      for (const f of arr(m.record_files).map(obj)) {
        const startedAtMs = Date.parse(str(f.record_start_time));
        candidates.push({
          source: 'tmeet',
          ref: str(f.record_file_id),
          meetingId: str(m.meeting_id),
          title: str(m.subject) || str(m.meeting_code),
          startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
          endedAtMs: Number.isFinite(Date.parse(str(f.record_end_time))) ? Date.parse(str(f.record_end_time)) : null,
        });
      }
    }
  } else {
    errors.tmeet = tmeet.reason instanceof Error ? tmeet.reason.message : String(tmeet.reason);
  }
  if (errors.feishu || errors.tmeet) logger.warn('[会议导入] 列候选时有一家没取到', errors);
  return { candidates: candidates.sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0)), errors };
}

/** 导入一场：拉转写、存成一场会。返回会议 id；created=false 表示之前导入过 */
export async function importMeeting(input: MeetingImportCandidate, deps: MeetingImportDeps): Promise<{ id: string; created: boolean }> {
  const now = deps.now?.() ?? Date.now();
  if (input.source === 'feishu') {
    const token = minuteTokenOf(input.ref);
    if (!token) throw new Error('这不是飞书妙记的链接');
    const d = await fetchFeishuMinute(deps.lark, token);
    const start = d.startedAtMs ?? input.startedAtMs ?? now;
    const lines: MeetingTranscriptLine[] = d.lines.map((l) => ({ atMs: start + l.offsetSec * 1000, speaker: l.speaker, text: l.text }));
    return deps.store.importMeeting({
      source: 'feishu', externalRef: token, title: d.title || input.title || token,
      startedAtMs: start, endedAtMs: lines.at(-1)?.atMs ?? start, lines, nowMs: now,
    });
  }
  if (!/^\d+$/.test(input.ref)) throw new Error('腾讯会议录制编号不对');
  const { lines: raw } = await fetchTmeetTranscript(deps.tmeet, input.ref, input.meetingId || undefined);
  const start = input.startedAtMs ?? now;
  const lines: MeetingTranscriptLine[] = raw.map((l) => ({ atMs: start + l.offsetSec * 1000, speaker: l.speaker, text: l.text }));
  return deps.store.importMeeting({
    source: 'tmeet', externalRef: input.ref, title: input.title || '腾讯会议',
    startedAtMs: start, endedAtMs: input.endedAtMs ?? lines.at(-1)?.atMs ?? start, lines, nowMs: now,
  });
}

export async function defaultImportDeps(): Promise<MeetingImportDeps> {
  const { getMeetingRecordStore } = await import('./meetingRecordsDefault');
  const { larkExec } = await import('../../tools/modules/connectors/feishuMinutes');
  const { tmeetExec } = await import('../../tools/modules/connectors/tmeetRecords');
  return { store: await getMeetingRecordStore(), lark: larkExec, tmeet: tmeetExec };
}
