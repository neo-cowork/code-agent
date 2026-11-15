import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMeetingRecordStore, type MeetingRecordStore } from '../../../../src/host/services/desktop/meetingRecords';
import {
  buildMinutesPrompt,
  runMeetingMinutes,
  validateMinutes,
  type MeetingMinutesDeps,
} from '../../../../src/host/services/desktop/meetingMinutes';

const T0 = new Date(2026, 10, 14, 15, 0).getTime();
const LINES = [
  '报价下周三前给到客户，这个我来跟。',
  '那我这边先核一下成本，成本表周五前发出来。',
  '交付周期还没定，等客户确认需求范围再说。',
  '就按礼品统一当实物处理，不再区分虚拟和实物了。',
  '另外原型图要改，取消场景层，活动直接挂礼品。',
  '接口的拆分我们下次会上再细聊，先这样。',
  '履约方式放在商品层还是活动层，我倾向商品层，但要跟强哥再确认一下。',
  '异常换货的时候要不要记备用礼品，这个业务那边还没给答复。',
  '发放记录的状态流转我画了个初稿，大家会后看一下有没有漏的状态。',
  '卡券和积分还是走各自的中心去发，礼品中心只做映射，不重复建主数据。',
  '如果活动结束后还有未领取的礼品，要不要自动回收，这个先记下来。',
];

let dir: string;
let db: string;
let store: MeetingRecordStore;
const sh = (sql: string) => execFileSync('sqlite3', [db, sql], { encoding: 'utf-8' });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-minutes-'));
  db = path.join(dir, 'desktop-activity.sqlite3');
  sh(`CREATE TABLE audio_segments (id TEXT PRIMARY KEY, start_at_ms INTEGER NOT NULL, end_at_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, wav_path TEXT, transcript TEXT, speaker_id INTEGER DEFAULT 0, asr_engine TEXT);
CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER, state TEXT NOT NULL, end_reason TEXT, updated_at_ms INTEGER NOT NULL);
INSERT INTO meetings VALUES ('m1', '报价评审', ${T0}, ${T0 + 3_600_000}, 'ended', 'manual', ${T0});
INSERT INTO meetings VALUES ('short', '寒暄', ${T0 + 7_200_000}, ${T0 + 7_260_000}, 'ended', 'manual', ${T0});
INSERT INTO audio_segments VALUES ('s1', ${T0 + 7_210_000}, ${T0 + 7_212_000}, 2000, NULL, '喂能听到吗', 2, 'w');
${LINES.map((t, i) => `INSERT INTO audio_segments VALUES ('a${i}', ${T0 + (i + 1) * 60_000}, ${T0 + (i + 1) * 60_000 + 5000}, 5000, NULL, '${t}', ${i % 2 ? 2 : 1}, 'w');`).join('\n')}`);
  store = createMeetingRecordStore((sql, json) => execFileSync('sqlite3', json ? ['-json', db, sql] : [db, sql], { encoding: 'utf-8' }));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const TRANSCRIPT = LINES.map((text, i) => ({ atMs: null, speaker: i % 2 ? 'James' : '林晨', text }));
const block = (v: unknown) => `整理好了：\n\`\`\`meeting_minutes\n${JSON.stringify(v)}\n\`\`\``;

describe('纪要校验：纪要里不许有会上没说过的话', () => {
  it('原话对得上才收；标点和空格不同不算对不上', () => {
    const r = validateMinutes(block({
      decisions: [{ text: '礼品统一按实物', quote: '就按礼品统一当实物处理 不再区分虚拟和实物了' }],
      actionItems: [],
      openQuestions: [{ text: '交付周期', quote: '交付周期还没定' }],
    }), TRANSCRIPT)!;
    expect(r.minutes.decisions).toHaveLength(1);
    expect(r.minutes.openQuestions).toHaveLength(1);
    expect(r.dropped).toBe(0);
  });

  it('原话在转写里找不到的整条丢掉', () => {
    const r = validateMinutes(block({
      decisions: [{ text: '预算批了 50 万', quote: '预算就批 50 万吧' }],
      actionItems: [{ text: '张三写方案', quote: '张三负责写方案', owner: '张三', due: '下周一' }],
      openQuestions: [],
    }), TRANSCRIPT)!;
    expect(r.minutes.decisions).toEqual([]);
    expect(r.minutes.actionItems).toEqual([]);
    expect(r.dropped).toBe(2);
  });

  it('负责人 / 截止只有原话里说了才留，否则置空（只列不派）', () => {
    const r = validateMinutes(block({
      decisions: [],
      actionItems: [
        { text: '给客户报价', quote: '报价下周三前给到客户，这个我来跟', owner: '我', due: '下周三' },
        { text: '核成本并发成本表', quote: '成本表周五前发出来', owner: '李四', due: '周五' },
        { text: '改原型图', quote: '原型图要改，取消场景层', owner: '林晨', due: '明天' },
      ],
      openQuestions: [],
    }), TRANSCRIPT)!;
    expect(r.minutes.actionItems.map((a) => [a.owner, a.due])).toEqual([['我', '下周三'], [null, '周五'], [null, null]]);
    expect(r.cleared).toBe(3);
  });

  it('原话是说话人自己认领（「这个我来跟」）：负责人可以是这句话的说话人，换成别人就清空', () => {
    const r = validateMinutes(block({
      decisions: [],
      actionItems: [
        { text: '给客户报价', quote: '报价下周三前给到客户，这个我来跟', owner: '林晨', due: null },
        { text: '给客户报价', quote: '报价下周三前给到客户，这个我来跟', owner: 'James', due: null },
        { text: '确认交付范围', quote: '交付周期还没定，等客户确认需求范围再说', owner: '林晨', due: null },
      ],
      openQuestions: [],
    }), TRANSCRIPT)!;
    expect(r.minutes.actionItems.map((a) => a.owner)).toEqual(['林晨', null, null]);
  });

  it('原话只有标点（归一后为空）不算出处，整条丢掉', () => {
    const r = validateMinutes(block({ decisions: [{ text: '编的决策', quote: '。，！' }], actionItems: [], openQuestions: [] }), TRANSCRIPT)!;
    expect(r.minutes.decisions).toEqual([]);
    expect(r.dropped).toBe(1);
  });

  it('上次退出时没出完的纪要（pending/running）新进程收尾成 failed，会议页可重新出', () => {
    store.setMinutesState('m1', 'running', 'sess-old');
    store.closeStaleMinutes();
    expect(store.get('m1')).toMatchObject({ minutesState: 'failed', minutesSessionId: 'sess-old' });
  });

  it('没有纪要块或不是 JSON：返回 null', () => {
    expect(validateMinutes('这场会主要讨论了报价。', TRANSCRIPT)).toBeNull();
    expect(validateMinutes('```meeting_minutes\n{决策: 1}\n```', TRANSCRIPT)).toBeNull();
  });

  it('提示词点名会议 id、要求原话出处、不许采用妙记/腾讯会议 AI 的负责人', () => {
    const p = buildMinutesPrompt(store.get('m1')!);
    expect(p).toContain('meeting_id 用 m1');
    expect(p).toContain('quote');
    expect(p).toContain('不要采用妙记或腾讯会议 AI 列的负责人');
  });
});

function deps(overrides: Partial<MeetingMinutesDeps> = {}): MeetingMinutesDeps & { runner: ReturnType<typeof vi.fn> } {
  const runner = vi.fn(async () => ({ finalOutput: block({
    decisions: [{ text: '礼品统一按实物', quote: '就按礼品统一当实物处理' }],
    actionItems: [{ text: '给客户报价', quote: '报价下周三前给到客户，这个我来跟', owner: '我', due: '下周三' }],
    openQuestions: [],
  }) }));
  return {
    store,
    isEnabled: () => true,
    createSession: async () => ({ id: 'sess-1' }),
    runner,
    ...overrides,
  } as MeetingMinutesDeps & { runner: ReturnType<typeof vi.fn> };
}

describe('散会自动出纪要', () => {
  it('出纪要：记言只拿 meeting_records，纪要落库、记下出纪要的会话', async () => {
    const d = deps();
    await runMeetingMinutes('m1', d);
    expect(d.runner).toHaveBeenCalledWith(expect.objectContaining({ roleId: '记言', sessionId: 'sess-1', allowedToolNames: ['meeting_records'] }));
    const m = store.get('m1')!;
    expect(m.minutesState).toBe('done');
    expect(m.minutesSessionId).toBe('sess-1');
    expect(m.minutes?.actionItems[0]).toMatchObject({ owner: '我', due: '下周三' });
  });

  it('记言会话里那条 JSON 回复改写成人能读的纪要：原话、负责人/截止，没有 JSON', async () => {
    const rewriteOutput = vi.fn(async () => {});
    await runMeetingMinutes('m1', deps({ rewriteOutput }));
    expect(rewriteOutput).toHaveBeenCalledTimes(1);
    const [sessionId, content] = rewriteOutput.mock.calls[0] as unknown as [string, string];
    expect(sessionId).toBe('sess-1');
    expect(content).toContain('### 决策');
    expect(content).toContain('- 给客户报价（负责人：我；截止：下周三）');
    expect(content).toContain('> 报价下周三前给到客户，这个我来跟');
    expect(content).toContain('### 未解问题\n（无）');
    expect(content).not.toContain('{"');
  });

  it('没按格式交回（纪要失败）时不改写会话，保留原回复方便查原因', async () => {
    const rewriteOutput = vi.fn(async () => {});
    await runMeetingMinutes('m1', deps({ rewriteOutput, runner: vi.fn(async () => ({ finalOutput: '好的' })) }));
    expect(rewriteOutput).not.toHaveBeenCalled();
  });

  it('开关关着：不调模型，标跳过；会议页手动点「重新出纪要」照出', async () => {
    const d = deps({ isEnabled: () => false });
    await runMeetingMinutes('m1', d);
    expect(d.runner).not.toHaveBeenCalled();
    expect(store.get('m1')!.minutesState).toBe('skipped');
    await runMeetingMinutes('m1', d, true);
    expect(store.get('m1')!.minutesState).toBe('done');
  });

  it('转写不到门槛字数（只有几句寒暄）：不调模型，标跳过', async () => {
    const d = deps();
    await runMeetingMinutes('short', d);
    expect(d.runner).not.toHaveBeenCalled();
    expect(store.get('short')!.minutesState).toBe('skipped');
  });

  it('记言没按格式交回 / 执行器报错：标失败，保留会话方便查原因', async () => {
    await runMeetingMinutes('m1', deps({ runner: vi.fn(async () => ({ finalOutput: '好的，我整理如下……' })) }));
    expect(store.get('m1')).toMatchObject({ minutesState: 'failed', minutesSessionId: 'sess-1', minutes: null });
    await runMeetingMinutes('m1', deps({ runner: vi.fn(async () => { throw new Error('model 429'); }) }));
    expect(store.get('m1')!.minutesState).toBe('failed');
  });
});
