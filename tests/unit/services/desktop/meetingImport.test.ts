// 导入飞书妙记 / 腾讯会议到会议页（N-MEETING-PAGE ⑤）：假 CLI（返回形状照 11-15 真跑抄）+ 真 sqlite 临时库
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMeetingRecordStore, type MeetingRecordStore } from '../../../../src/host/services/desktop/meetingRecords';
import { importMeeting, listMeetingImportCandidates } from '../../../../src/host/services/desktop/meetingImport';
import type { LarkExec } from '../../../../src/host/tools/modules/connectors/feishuMinutes';

let dir: string;
let store: MeetingRecordStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-import-'));
  const db = path.join(dir, 'desktop-activity.sqlite3');
  execFileSync('sqlite3', [db, 'CREATE TABLE audio_segments (id TEXT PRIMARY KEY, start_at_ms INTEGER NOT NULL, end_at_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, wav_path TEXT, transcript TEXT, speaker_id INTEGER DEFAULT 0, asr_engine TEXT);']);
  store = createMeetingRecordStore((sql, json) => execFileSync('sqlite3', json ? ['-json', db, sql] : [db, sql], { encoding: 'utf-8' }));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const TRANSCRIPT = `2026-11-01 21:07:26 CST|59min 36s

Speaker 1 00:00:00.520
先说考试题目。

Speaker 2 00:01:16.080
好的。
`;

const lark: LarkExec = async (args, _label, cwd) => {
  if (args[1] === '+search') {
    return JSON.stringify({ ok: true, data: { has_more: false, items: [{ token: 'tok1', display_info: '考试要点讲解\n关键词', meta_data: { description: '所有者: 某人 开始时间: 2026.11.01 21:07:26 时长: 59 分 36 秒' } }] } });
  }
  const d = path.join(cwd!, 'artifact-x-tok1');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'transcript.txt'), TRANSCRIPT);
  return JSON.stringify({ ok: true, data: { minutes: [{ minute_token: 'tok1', title: '考试要点讲解', artifacts: { summary: 's', todos: [] } }] } });
};

const para = (pid: number, start: string, who: string, text: string) => ({ pid: String(pid), start_time: start, speaker: { user_name: who }, sentences: [{ words: [{ text }] }] });
const tmeet = async (args: string[]) => (args[1] === 'list'
  ? JSON.stringify({ data: { record_meetings: [
    { meeting_id: 'm-a', subject: '别人的会', media_start_time: '2026-11-03T18:56:05+08:00' },
    { meeting_id: 'm-b', subject: '评审会', record_files: [{ record_file_id: '211', record_start_time: '2026-10-30T15:06:34+08:00', record_end_time: '2026-10-30T16:40:01+08:00' }] },
  ] } })
  : JSON.stringify({ data: { more: false, minutes: { paragraphs: [para(0, '00:01', '张三', '先看礼品类型'), para(1, '01:05', '李四', '那就这么定')] } } }));

describe('导入外部会议', () => {
  it('候选：妙记 + 有录制文件的腾讯会议，按时间倒序；没录制文件的不列', async () => {
    const { candidates, errors } = await listMeetingImportCandidates({ store, lark, tmeet, now: () => Date.parse('2026-11-15T00:00:00+08:00') });
    expect(errors).toEqual({});
    expect(candidates.map((c) => [c.source, c.ref, c.title])).toEqual([['feishu', 'tok1', '考试要点讲解'], ['tmeet', '211', '评审会']]);
    expect(candidates[0].startedAtMs).toBe(Date.parse('2026-11-01T21:07:26+08:00'));
  });

  it('某一家没连接：另一家照常列，带回原因', async () => {
    const broken: LarkExec = async () => { throw new Error('飞书还没连接'); };
    const { candidates, errors } = await listMeetingImportCandidates({ store, lark: broken, tmeet });
    expect(candidates.map((c) => c.source)).toEqual(['tmeet']);
    expect(errors.feishu).toContain('飞书还没连接');
  });

  it('导入妙记：成为一场会，转写带绝对时刻和说话人；同一条再导入不重复建', async () => {
    const first = await importMeeting({ source: 'feishu', ref: 'https://x.feishu.cn/minutes/tok1', title: '', startedAtMs: null }, { store, lark, tmeet });
    expect(first.created).toBe(true);
    const m = store.get(first.id)!;
    expect(m).toMatchObject({ source: 'feishu', externalRef: 'tok1', title: '考试要点讲解', state: 'ended' });
    expect(store.transcript(m)).toEqual([
      { atMs: Date.parse('2026-11-01T21:07:26+08:00'), speaker: 'Speaker 1', text: '先说考试题目。' },
      { atMs: Date.parse('2026-11-01T21:07:26+08:00') + 76_000, speaker: 'Speaker 2', text: '好的。' },
    ]);
    const again = await importMeeting({ source: 'feishu', ref: 'tok1', title: '', startedAtMs: null }, { store, lark, tmeet });
    expect(again).toEqual({ id: first.id, created: false });
    expect(store.list(10)).toHaveLength(1);
  });

  it('导入腾讯会议录制：时刻按录制开始加偏移；会议能被 meeting_records 搜到', async () => {
    const start = Date.parse('2026-10-30T15:06:34+08:00');
    const r = await importMeeting({ source: 'tmeet', ref: '211', meetingId: 'm-b', title: '评审会', startedAtMs: start, endedAtMs: start + 5_607_000 }, { store, lark, tmeet });
    const m = store.get(r.id)!;
    expect(store.transcript(m).map((l) => [l.atMs! - start, l.speaker])).toEqual([[1000, '张三'], [65_000, '李四']]);
    expect(store.search('礼品', 5).map((h) => h.meeting.id)).toEqual([r.id]);
  });

  it('不是妙记链接 / 录制编号不对：报可读错误，不调 CLI', async () => {
    await expect(importMeeting({ source: 'feishu', ref: 'rm -rf /', title: '', startedAtMs: null }, { store, lark, tmeet })).rejects.toThrow('这不是飞书妙记的链接');
    await expect(importMeeting({ source: 'tmeet', ref: '--help', title: '', startedAtMs: null }, { store, lark, tmeet })).rejects.toThrow('腾讯会议录制编号不对');
  });
});
