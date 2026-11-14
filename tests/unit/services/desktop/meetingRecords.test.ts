import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMeetingRecordStore, formatTranscript, type MeetingSqlRunner } from '../../../../src/host/services/desktop/meetingRecords';
import { createSqliteMeetingStore } from '../../../../src/host/services/desktop/meetingSession';
import { runMeetingRecords } from '../../../../src/host/tools/modules/lightMemory/meetingRecords';

// 真 sqlite3 CLI + 临时库：会议表迁移、upsert、join audio_segments 都是 SQL 行为，mock 掉就测不到
let dir: string;
let db: string;
const run: MeetingSqlRunner = (sql, json) => execFileSync('sqlite3', json ? ['-json', db, sql] : [db, sql], { encoding: 'utf-8' });
const sh = (sql: string) => execFileSync('sqlite3', [db, sql], { encoding: 'utf-8' });

const T0 = new Date(2026, 10, 14, 15, 0).getTime();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-records-'));
  db = path.join(dir, 'desktop-activity.sqlite3');
  // N-MEETING-SESSION 时的老表结构 + 录音段
  sh(`CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER, state TEXT NOT NULL, end_reason TEXT, updated_at_ms INTEGER NOT NULL);
CREATE TABLE audio_segments (id TEXT PRIMARY KEY, start_at_ms INTEGER NOT NULL, end_at_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, wav_path TEXT, transcript TEXT, speaker_id INTEGER DEFAULT 0, asr_engine TEXT);
INSERT INTO meetings VALUES ('m1', '报价评审', ${T0}, ${T0 + 3_600_000}, 'ended', 'manual', ${T0});
INSERT INTO audio_segments VALUES ('a1', ${T0 + 60_000}, ${T0 + 65_000}, 5000, NULL, '报价下周三前给到客户', 1, 'whisper');
INSERT INTO audio_segments VALUES ('a2', ${T0 + 120_000}, ${T0 + 125_000}, 5000, NULL, '那我这边先核一下成本', 2, 'whisper');
INSERT INTO audio_segments VALUES ('a3', ${T0 + 7_200_000}, ${T0 + 7_205_000}, 5000, NULL, '会后闲聊不算这场会', 1, 'whisper');`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('会议记录', () => {
  it('老库补列，原来的会照常读出来，来源默认本机录音', () => {
    const store = createMeetingRecordStore(run);
    const [m] = store.list(10);
    expect(m).toMatchObject({ id: 'm1', title: '报价评审', source: 'recorded', minutes: null, minutesState: null });
    expect(sh('PRAGMA table_info(meetings);')).toContain('minutes_json');
  });

  it('转写只取这场会起止时间内的段，标出我/对方', () => {
    const store = createMeetingRecordStore(run);
    const lines = store.transcript(store.get('m1')!);
    expect(lines.map((l) => [l.speaker, l.text])).toEqual([['我', '报价下周三前给到客户'], ['对方', '那我这边先核一下成本']]);
  });

  it('记这场会的心跳保存不会冲掉已写的纪要（upsert，不是删行重插）', () => {
    createMeetingRecordStore(run).list(1); // 触发迁移
    sh(`UPDATE meetings SET minutes_json = '{"decisions":[],"actionItems":[],"openQuestions":[]}', minutes_state = 'done' WHERE id = 'm1';`);
    const session = createSqliteMeetingStore(() => db, (p, sql, json) => run(sql, Boolean(json)));
    session.save({ id: 'm1', title: '报价评审（改名）', startedAtMs: T0, endedAtMs: T0 + 3_600_000, state: 'ended', endReason: 'manual' }, T0 + 1);
    const m = createMeetingRecordStore(run).get('m1')!;
    expect(m.title).toBe('报价评审（改名）');
    expect(m.minutesState).toBe('done');
  });

  it('搜索能搜到转写里的话，只算落在会议时间内的', () => {
    const store = createMeetingRecordStore(run);
    expect(store.search('成本', 10).map((h) => h.meeting.id)).toEqual(['m1']);
    expect(store.search('闲聊', 10)).toEqual([]);
  });

  it('关键词里的 % 和 _ 按字面匹配', () => {
    const store = createMeetingRecordStore(run);
    expect(store.search('%', 10)).toEqual([]);
  });

  it('工具 read 带出纪要和转写，负责人/截止缺失写待认领/待定', () => {
    const store = createMeetingRecordStore(run);
    store.list(1);
    sh(`UPDATE meetings SET minutes_state = 'done', minutes_json = '{"decisions":[],"actionItems":[{"text":"给客户报价","quote":"报价下周三前给到客户","owner":null,"due":"下周三"}],"openQuestions":[]}' WHERE id = 'm1';`);
    const r = runMeetingRecords(store, { action: 'read', meeting_id: 'm1' });
    expect(r.ok).toBe(true);
    const out = r.ok ? r.output : '';
    expect(out).toContain('负责人：待认领 · 截止：下周三');
    expect(out).toContain('[15:01 我] 报价下周三前给到客户');
  });

  it('工具参数错给出可读错误', () => {
    const store = createMeetingRecordStore(run);
    expect(runMeetingRecords(store, { action: 'read' })).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(runMeetingRecords(store, { action: 'read', meeting_id: 'nope' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('转写超出预算从头保留，标出省略', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ atMs: null, speaker: '', text: `第${i}句话` }));
    const { text, truncated } = formatTranscript(lines, 20);
    expect(truncated).toBe(true);
    expect(text.startsWith('第0句话')).toBe(true);
    expect(text).toContain('已省略');
  });
});
