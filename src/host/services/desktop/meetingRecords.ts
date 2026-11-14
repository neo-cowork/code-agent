// ============================================================================
// 会议记录读取（N-MEETING-PAGE）：会议页、meeting_records 工具、会后纪要共用
//
// 和 meetingSession.ts 同一张 meetings 表（desktop-activity.sqlite3，sqlite3 CLI）。
// 本单给表加列：来源、外部编号、导入的转写、纪要、纪要状态、出纪要的会话。
// 本机录的会，转写就是起止时间内的 audio_segments；导入的会，转写存在 imported_transcript。
// ============================================================================

import { execFileSync } from 'node:child_process';
import { MEETING_SESSION_LIMITS } from '../../../shared/constants';
import {
  AUDIO_SPEAKER_ID,
  type MeetingMinutes,
  type MeetingMinutesState,
  type MeetingSource,
  type MeetingSummaryRecord,
  type MeetingTranscriptLine,
} from '../../../shared/contract/audioCapture';
import { createLogger } from '../infra/logger';
import { MEETINGS_DDL } from './meetingSession';

const logger = createLogger('MeetingRecords');

/** 本单加的列；老库按缺哪列补哪列（sqlite 的 ADD COLUMN 遇到已有列会报错，所以先查） */
const EXTRA_COLUMNS: Array<[string, string]> = [
  ['source', "TEXT NOT NULL DEFAULT 'recorded'"],
  ['external_ref', 'TEXT'],
  ['imported_transcript', 'TEXT'],
  ['minutes_json', 'TEXT'],
  ['minutes_state', 'TEXT'],
  ['minutes_session_id', 'TEXT'],
];

export type MeetingSqlRunner = (sql: string, json: boolean) => string;

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const likePattern = (v: string) => q(`%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);

interface MeetingRow {
  id: string;
  title: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  state: MeetingSummaryRecord['state'];
  end_reason: MeetingSummaryRecord['endReason'];
  source: MeetingSource | null;
  external_ref: string | null;
  minutes_json: string | null;
  minutes_state: MeetingMinutesState | null;
  minutes_session_id: string | null;
}

const ROW_COLUMNS = 'id, title, started_at_ms, ended_at_ms, state, end_reason, source, external_ref, minutes_json, minutes_state, minutes_session_id';

function parseMinutes(raw: string | null): MeetingMinutes | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<MeetingMinutes>;
    return {
      decisions: Array.isArray(v.decisions) ? v.decisions : [],
      actionItems: Array.isArray(v.actionItems) ? v.actionItems : [],
      openQuestions: Array.isArray(v.openQuestions) ? v.openQuestions : [],
    };
  } catch {
    logger.warn('[会议] 纪要内容不是合法 JSON，按没有纪要处理');
    return null;
  }
}

function toRecord(r: MeetingRow): MeetingSummaryRecord {
  return {
    id: r.id,
    title: r.title,
    startedAtMs: r.started_at_ms,
    endedAtMs: r.ended_at_ms,
    state: r.state,
    endReason: r.end_reason,
    source: r.source ?? 'recorded',
    externalRef: r.external_ref,
    minutesState: r.minutes_state,
    minutes: parseMinutes(r.minutes_json),
    minutesSessionId: r.minutes_session_id,
  };
}

function speakerLabel(id: number | null | undefined): string {
  if (id === AUDIO_SPEAKER_ID.ME) return '我';
  if (id === AUDIO_SPEAKER_ID.OTHERS) return '对方';
  return '';
}

export interface MeetingRecordStore {
  list(limit: number): MeetingSummaryRecord[];
  get(id: string): MeetingSummaryRecord | null;
  /** 整场转写，按时间正序 */
  transcript(record: MeetingSummaryRecord): MeetingTranscriptLine[];
  /** 标题、纪要、转写里含关键词的会，每条带一段命中原文 */
  search(query: string, limit: number): Array<{ meeting: MeetingSummaryRecord; snippet: string; atMs: number | null }>;
}

export function createMeetingRecordStore(run: MeetingSqlRunner): MeetingRecordStore {
  let migrated = false;
  const exec = (sql: string, json = false): string => {
    if (!migrated) {
      const info = run(`${MEETINGS_DDL}\nPRAGMA table_info(meetings);`, true).trim();
      if (!info) return ''; // 库打不开：这次什么都不做，下次再试迁移（runner 已记过原因）
      const have = new Set((JSON.parse(info) as Array<{ name: string }>).map((c) => c.name));
      const missing = EXTRA_COLUMNS.filter(([name]) => !have.has(name));
      if (missing.length) run(missing.map(([name, type]) => `ALTER TABLE meetings ADD COLUMN ${name} ${type};`).join('\n'), false);
      migrated = true;
    }
    return run(`${MEETINGS_DDL}\n${sql}`, json).trim();
  };
  const rows = (sql: string): MeetingRow[] => {
    const out = exec(sql, true);
    return out ? (JSON.parse(out) as MeetingRow[]) : [];
  };
  const get = (id: string) => rows(`SELECT ${ROW_COLUMNS} FROM meetings WHERE id = ${q(id)};`).map(toRecord)[0] ?? null;

  return {
    list(limit) {
      return rows(`SELECT ${ROW_COLUMNS} FROM meetings ORDER BY started_at_ms DESC LIMIT ${Math.trunc(limit)};`).map(toRecord);
    },
    get,
    transcript(record) {
      if (record.source !== 'recorded') {
        const out = exec(`SELECT imported_transcript AS t FROM meetings WHERE id = ${q(record.id)};`, true);
        const raw = out ? (JSON.parse(out) as Array<{ t: string | null }>)[0]?.t : null;
        if (!raw) return [];
        try {
          return JSON.parse(raw) as MeetingTranscriptLine[];
        } catch {
          logger.warn('[会议] 导入的转写不是合法 JSON', { meetingId: record.id });
          return [];
        }
      }
      const to = record.endedAtMs ?? Number.MAX_SAFE_INTEGER;
      const out = exec(`SELECT start_at_ms, transcript, speaker_id FROM audio_segments WHERE start_at_ms >= ${Math.trunc(record.startedAtMs)} AND start_at_ms < ${Math.trunc(to)} AND transcript IS NOT NULL AND TRIM(transcript) != '' ORDER BY start_at_ms ASC;`, true);
      if (!out) return [];
      return (JSON.parse(out) as Array<{ start_at_ms: number; transcript: string; speaker_id: number | null }>)
        .map((s) => ({ atMs: s.start_at_ms, speaker: speakerLabel(s.speaker_id), text: s.transcript.trim() }));
    },
    search(query, limit) {
      const like = likePattern(query);
      const hits: Array<{ id: string; text: string; atMs: number | null }> = [];
      const metaOut = exec(`SELECT id, title, minutes_json, imported_transcript FROM meetings WHERE title LIKE ${like} ESCAPE '\\' OR minutes_json LIKE ${like} ESCAPE '\\' OR imported_transcript LIKE ${like} ESCAPE '\\' ORDER BY started_at_ms DESC LIMIT ${Math.trunc(limit)};`, true);
      for (const r of metaOut ? JSON.parse(metaOut) as Array<{ id: string; title: string; minutes_json: string | null; imported_transcript: string | null }> : []) {
        const field = [r.title, r.minutes_json ?? '', r.imported_transcript ?? ''].find((t) => t.includes(query)) ?? r.title;
        hits.push({ id: r.id, text: field, atMs: null });
      }
      const audio = exec(`SELECT m.id AS id, a.start_at_ms AS at, a.transcript AS text FROM meetings m JOIN audio_segments a ON a.start_at_ms >= m.started_at_ms AND a.start_at_ms < COALESCE(m.ended_at_ms, ${Number.MAX_SAFE_INTEGER}) WHERE m.source = 'recorded' AND a.transcript LIKE ${like} ESCAPE '\\' ORDER BY a.start_at_ms DESC LIMIT ${Math.trunc(limit)};`, true);
      if (audio) for (const a of JSON.parse(audio) as Array<{ id: string; at: number; text: string }>) hits.push({ id: a.id, text: a.text, atMs: a.at });
      const byId = new Map<string, MeetingSummaryRecord | null>();
      const result: Array<{ meeting: MeetingSummaryRecord; snippet: string; atMs: number | null }> = [];
      for (const h of hits) {
        if (result.length >= limit) break;
        if (!byId.has(h.id)) byId.set(h.id, get(h.id));
        const meeting = byId.get(h.id);
        if (meeting) result.push({ meeting, snippet: snippetAround(h.text, query), atMs: h.atMs });
      }
      return result;
    },
  };
}

/** 命中处前后各取一段，长文本不整段塞给模型 */
export function snippetAround(text: string, query: string, radius = 60): string {
  const i = text.indexOf(query);
  if (i < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + query.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** 转写按预算从头装（出纪要要从开头读起），装不下标出省略 */
export function formatTranscript(lines: MeetingTranscriptLine[], maxChars = MEETING_SESSION_LIMITS.RECORDS_READ_MAX_CHARS): { text: string; truncated: boolean } {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const t = line.atMs === null ? '' : new Date(line.atMs).toTimeString().slice(0, 5);
    const head = [t, line.speaker].filter(Boolean).join(' ');
    const s = `${head ? `[${head}] ` : ''}${line.text}`;
    if (used + s.length + 1 > maxChars) return { text: `${out.join('\n')}\n...(后面的部分超出长度，已省略)`, truncated: true };
    out.push(s);
    used += s.length + 1;
  }
  return { text: out.join('\n'), truncated: false };
}

let defaultStore: MeetingRecordStore | null = null;

/** 生产用：录音库路径同 desktopAudioCapture.getSqlitePath（库不存在会先建） */
export async function getMeetingRecordStore(): Promise<MeetingRecordStore> {
  if (defaultStore) return defaultStore;
  const { getSqlitePath, ensureAudioTable } = await import('./desktopAudioCapture');
  let audioReady = false;
  defaultStore = createMeetingRecordStore((sql, json) => {
    const dbPath = getSqlitePath();
    if (!dbPath) return '';
    if (!audioReady) {
      ensureAudioTable(dbPath); // 会议表 join audio_segments：采集器从没写过时表可能还不存在
      audioReady = true;
    }
    try {
      return execFileSync('sqlite3', json ? ['-json', dbPath, sql] : [dbPath, sql], { encoding: 'utf-8' });
    } catch (error) {
      logger.warn('[会议] 读写会议记录失败', { error: error instanceof Error ? error.message : String(error) });
      return '';
    }
  });
  return defaultStore;
}
