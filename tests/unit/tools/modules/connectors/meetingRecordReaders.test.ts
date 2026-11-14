// 腾讯会议录制 / 飞书妙记只读工具（N-MEETING-PAGE）。
// 夹具字段结构照 11-15 Dev 包真跑 tmeet 1.0.15 / lark-cli 1.0.89 的返回逐字段抄（内容换成虚构的）。
import { describe, expect, it } from 'vitest';
import {
  clockToSeconds,
  fetchTmeetTranscript,
  friendlyTmeetError,
  runTmeetRecordList,
  runTmeetRecordRead,
} from '../../../../../src/host/tools/modules/connectors/tmeetRecords';
import {
  friendlyLarkError,
  minuteTokenOf,
  parseFeishuTranscript,
  runFeishuMinutesRead,
  runFeishuMinutesSearch,
  type LarkExec,
} from '../../../../../src/host/tools/modules/connectors/feishuMinutes';
import * as fs from 'fs/promises';
import * as path from 'path';

const ok = (data: unknown) => JSON.stringify({ trace_id: 't', message: 'success', data });

const para = (pid: number, start: string, who: string, text: string) => ({
  pid: String(pid), start_time: start, end_time: start, lang: 'zh',
  speaker: { user_id: '1', user_name: who, avatar_url: '' },
  sentences: [{ sid: String(pid), start_time: start, end_time: start, words: [{ wid: '0', start_time: start, end_time: start, text }] }],
});

describe('腾讯会议录制', () => {
  it('时长字符串转秒', () => {
    expect(clockToSeconds('00:16')).toBe(16);
    expect(clockToSeconds('1:02:03')).toBe(3723);
  });

  it('列录制：带 record_file_id；别人主持没文件的说清楚原因', async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return ok({
        has_more: false, next_page_token: '',
        record_meetings: [
          { meeting_id: 'm-a', subject: '别人的会', media_start_time: '2026-11-03T18:56:05+08:00', record_type: '云录制' },
          { meeting_id: 'm-b', subject: '评审会', media_start_time: '2026-10-30T15:06:34+08:00', record_type: '文字转写',
            record_files: [{ record_file_id: 'rf-1', record_start_time: '2026-10-30T15:06:34+08:00', record_end_time: '2026-10-30T16:40:01+08:00' }] },
        ],
      });
    };
    const r = await runTmeetRecordList(exec, { start: '2026-10-15T00:00+08:00', end: '2026-11-14T23:59+08:00' });
    expect(calls[0]).toEqual(['record', 'list', '--start', '2026-10-15T00:00+08:00', '--end', '2026-11-14T23:59+08:00', '--format', 'json']);
    expect(r.ok && r.output).toContain('record_file_id rf-1');
    expect(r.ok && r.output).toContain('没有可查看的录制文件');
  });

  it('列录制没给时间窗也没给会议号：参数错误，不调 CLI', async () => {
    let called = false;
    const r = await runTmeetRecordList(async () => { called = true; return ''; }, { start: '2026-10-15' });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(called).toBe(false);
  });

  it('转写按 more 分页，下一页从最后一段 pid+1 起；带发言人和时刻', async () => {
    const pids: string[] = [];
    const exec = async (args: string[]) => {
      const pid = args[args.indexOf('--pid') + 1];
      pids.push(pid);
      return pid === '0'
        ? ok({ code: 0, more: true, minutes: { paragraphs: [para(0, '00:01', '张三', '先看礼品类型'), para(1, '00:14', '李四', '按实际情况建商品')] } })
        : ok({ code: 0, more: false, minutes: { paragraphs: [para(2, '01:05', '张三', '那就这么定')] } });
    };
    const { lines, truncated } = await fetchTmeetTranscript(exec, 'rf-1', 'm-b');
    expect(pids).toEqual(['0', '2']);
    expect(truncated).toBe(false);
    expect(lines).toEqual([
      { offsetSec: 1, speaker: '张三', text: '先看礼品类型' },
      { offsetSec: 14, speaker: '李四', text: '按实际情况建商品' },
      { offsetSec: 65, speaker: '张三', text: '那就这么定' },
    ]);
  });

  it('读录制：智能纪要和 AI 待办标明不是原话，待办去掉列表前缀', async () => {
    const exec = async (args: string[]) => (args[1] === 'smart-minutes'
      ? ok({ meeting_minute: { minute: '会议主题：评审', todo: '', todos: [{ content: '-   修改原型图 @林晨', executor_list: [{ nick: '林晨' }] }] } })
      : ok({ code: 0, more: false, minutes: { paragraphs: [para(0, '00:01', '张三', '先看礼品类型')] } }));
    const r = await runTmeetRecordRead(exec, { record_file_id: 'rf-1' });
    const out = r.ok ? r.output : '';
    expect(out).toContain('腾讯会议 AI 生成，不是原话');
    expect(out).toContain('- 修改原型图 @林晨');
    expect(out).toContain('[00:01 张三] 先看礼品类型');
  });

  it('没登录：提示去设置连接腾讯会议', () => {
    expect(friendlyTmeetError(Object.assign(new Error('exit 1'), { stdout: "Not logged in. Please use 'tmeet auth login' to authenticate.", stderr: '' })))
      .toContain('设置 → 连接器 → 腾讯会议');
  });
});

const TRANSCRIPT = `2026-11-01 21:07:26 CST|59min 36s

Keywords:
模块、流程图

Speaker 1 00:00:00.520
开胃菜啊，先说考试题目。

Speaker 2 00:01:16.080
怎么跑不动啊？
再试一次。
`;

describe('飞书妙记', () => {
  it('从链接或 token 取 token', () => {
    expect(minuteTokenOf('https://abc.feishu.cn/minutes/obcnypve16wth988nf3g2868?from=x')).toBe('obcnypve16wth988nf3g2868');
    expect(minuteTokenOf('obcnypve16wth988nf3g2868')).toBe('obcnypve16wth988nf3g2868');
    expect(minuteTokenOf('rm -rf /')).toBeNull();
  });

  it('解析 transcript.txt：首行开始时间（北京时间）、说话人与时刻、多行正文合并', () => {
    const { startedAtMs, lines } = parseFeishuTranscript(TRANSCRIPT);
    expect(startedAtMs).toBe(Date.parse('2026-11-01T21:07:26+08:00'));
    expect(lines).toEqual([
      { offsetSec: 0, speaker: 'Speaker 1', text: '开胃菜啊，先说考试题目。' },
      { offsetSec: 76, speaker: 'Speaker 2', text: '怎么跑不动啊？再试一次。' },
    ]);
  });

  it('搜索：标题取 display_info 首行，前面夹着 WARN 行也能解析，有下一页给 page_token', async () => {
    const exec: LarkExec = async () => `[lark-cli] [WARN] proxy detected\n${JSON.stringify({
      ok: true, identity: 'user',
      data: { has_more: true, page_token: 'p2', items: [{ token: 'tok1', display_info: '考试要点讲解\n关键词: 模块', meta_data: { description: '所有者: 某人 开始时间: 2026.11.01 21:07:26 时长: 59 分 36 秒', app_link: 'https://x.feishu.cn/minutes/tok1' } }] },
    })}`;
    const r = await runFeishuMinutesSearch(exec, { query: '考试' });
    expect(r.ok && r.output).toContain('- 考试要点讲解 · token tok1 · 所有者: 某人 开始时间: 2026.11.01 21:07:26');
    expect(r.ok && r.output).toContain('page_token: p2');
  });

  it('读妙记：在临时目录里跑（转写只收相对路径），读回转写，跑完删掉临时目录', async () => {
    let cwdSeen = '';
    const exec: LarkExec = async (args, _label, cwd) => {
      cwdSeen = cwd ?? '';
      expect(args).toEqual(expect.arrayContaining(['--output-dir', '.', '--minute-tokens', 'tok1', '--transcript']));
      const dir = path.join(cwd!, 'artifact-考试要点讲解-tok1');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'transcript.txt'), TRANSCRIPT);
      return JSON.stringify({ ok: true, data: { minutes: [{ minute_token: 'tok1', title: '考试要点讲解', artifacts: { summary: '讲了考试规则', todos: [{ content: '分享模拟界面', is_done: false }] } }] } });
    };
    const r = await runFeishuMinutesRead(exec, { minute: 'https://x.feishu.cn/minutes/tok1' });
    const out = r.ok ? r.output : '';
    expect(out).toContain('# 考试要点讲解');
    expect(out).toContain('飞书 AI 摘要（不是原话）');
    expect(out).toContain('- 分享模拟界面');
    expect(out).toContain('[01:16 Speaker 2] 怎么跑不动啊？再试一次。');
    await expect(fs.access(cwdSeen)).rejects.toThrow();
  });

  it('老用户缺妙记权限 / 没连接：给能照做的提示，不说「联系管理员」', () => {
    const scope = friendlyLarkError(Object.assign(new Error('exit 1'), { stdout: '{"ok":false,"error":{"type":"permission","message":"missing scope: minutes:minutes:readonly"}}', stderr: '' }));
    expect(scope).toContain('重新连接一次，会多申请妙记只读权限');
    const none = friendlyLarkError(Object.assign(new Error('exit 1'), { stdout: '{"ok":false,"error":{"subtype":"not_configured","message":"profile \\"neo\\" not found"}}', stderr: '' }));
    expect(none).toContain('飞书还没连接');
  });
});
