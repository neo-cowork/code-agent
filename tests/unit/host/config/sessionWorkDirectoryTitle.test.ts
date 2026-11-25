import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  materializeSessionWorkDirectory, maybeReplanSessionWorkDirectory, needsWorkspaceModelTitleForDeliverable, planSessionWorkDirectory,
} from '../../../../src/host/config/sessionWorkDirectory';
import { SESSION_WORK_DIRECTORY_TIMEOUTS } from '../../../../src/shared/constants/timeouts';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../../../../src/host/services/infra/logger', () => ({ createLogger: () => log }));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));

const rr85 = '我把合同文件夹整个拖进来了（共 30 份：PDF、Excel 表、图片、文本都有），请逐份摘要并写入 notes.md';
const cases = [
  [rr85, '合同文件夹逐份摘要', '逐份摘要并写入 notes', 'zh'],
  ['请帮我整理 `/tmp/contracts` 和 /tmp/notes 的会议记录（附原始资料），输出摘要', '会议记录摘要', 'untitled', 'zh'],
  ['Please help me organize all the contracts and produce a detailed summary for the team (thirty documents)', 'Contract collection summary', 'organize all the contracts', 'en'],
] as const;
/** 以虚词/助词/连词/冠词收尾 = 半句。 */
const DANGLING_END = /(?:[的了着过吗呢吧和与及或跟在把被对给向为从到]|\b(?:the|a|an|of|to|for|and|or|in|on|at|with|by|from|into|about|as|is|are|be))$/i;
/** 删掉记号留下的洞：洞标记本身、连续空白，或空白夹着的单个虚词（`整理 和 的会议记录`）。 */
const HOLE = /\uE000|\s{2}|(?:^|\s)[的了着过吗呢吧和与及或跟同在把被对给向为从到](?:\s|$)/;
let home: string;
let env: NodeJS.ProcessEnv;
const now = new Date(2026, 10, 13, 12).getTime();
beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(path.join(tmpdir(), 'folder-title-'));
  env = { CODE_AGENT_HOME: home, CODE_AGENT_DATA_DIR: path.join(home, '.code-agent') };
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});

describe('first-turn task folder title through planSessionWorkDirectory', () => {
  it.each(cases)('① short task name for %s with and without a model', async (userMessage, modelTitle, ruleTitle, language) => {
    const askTitle = vi.fn(async () => ({ success: true, content: modelTitle }));
    const model = await planSessionWorkDirectory({ userMessage, askTitle, now, env, language });
    const rule = await planSessionWorkDirectory({ userMessage, now, env, language });
    const prefix = language === 'en' ? 'Task' : '任务';
    expect(path.basename(model)).toBe(`${prefix}_1113_${modelTitle}`);
    expect(path.basename(rule)).toBe(`${prefix}_1113_${ruleTitle}`);
    expect(askTitle).toHaveBeenCalledOnce();
    expect(askTitle).toHaveBeenCalledWith(expect.stringContaining('Generate a short session title'), expect.any(AbortSignal));
    expect(log.info.mock.calls.map(([line]) => line)).toEqual([
      expect.stringMatching(/source=model elapsedMs=\d+ reason=short-title/),
      expect.stringMatching(/source=rule elapsedMs=\d+ reason=unavailable/),
    ]);
    console.log(`① model=${path.basename(model)} rule=${path.basename(rule)}`);
  });

  it('② keeps a short clean clause and never calls the model', async () => {
    const askTitle = vi.fn();
    const result = await planSessionWorkDirectory({ userMessage: '整理本周会议纪要，按日期分组', askTitle, now, env });
    expect(path.basename(result)).toBe('任务_1113_整理本周会议纪要');
    expect(askTitle).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/source=short-clean elapsedMs=\d+ reason=clean-first-clause/));
  });

  it.each([
    ['unavailable', undefined],
    ['echo', { success: true, content: rr85 }],
    ['echo', { success: true, content: '我把合同文件夹整个拖进来了…' }],
    ['no-answer', { success: false }],
    ['no-answer', { success: true, content: '' }],
    ['invalid-answer', { success: true, content: '请整理合同' }],
    ['invalid-answer', { success: true, content: '/tmp/contracts' }],
  ] as const)('③ falls back with reason=%s', async (reason, answer) => {
    const result = await planSessionWorkDirectory({ userMessage: rr85, askTitle: async () => answer, now, env });
    expect(path.basename(result)).toBe('任务_1113_逐份摘要并写入 notes');
    expect(log.info).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(new RegExp(`source=rule elapsedMs=\\d+ reason=${reason}$`)));
    console.log(log.info.mock.calls[0][0]);
  });

  it.each([
    ['【紧急】帮我整理合同并逐份写摘要到 notes.md', '任务_1113_整理合同并逐份写摘要到 notes'],
    ['（续）上次的报告再补充一下数据来源和图表说明', '任务_1113_上次的报告再补充一下数据来源和图表说明'],
    ['【紧急】', '任务_1113_紧急'],
  ] as const)('r1 leading-bracket message %s never degrades to untitled', async (userMessage, expected) => {
    const result = await planSessionWorkDirectory({ userMessage, askTitle: async () => undefined, now, env });
    expect(path.basename(result)).toBe(expected);
    expect(path.basename(result)).not.toContain('untitled');
    console.log(`r1 ${path.basename(result)}`);
  });

  it('③ times out at exactly 3 s, aborts the call and ignores a late answer', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let complete: ((answer: { success: boolean; content: string }) => void) | undefined;
    const askTitle = vi.fn((_prompt: string, incoming: AbortSignal) => {
      signal = incoming;
      return new Promise<{ success: boolean; content: string }>(resolve => { complete = resolve; });
    });
    const result = planSessionWorkDirectory({ userMessage: rr85, askTitle, now, env });
    let settled = false;
    void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(SESSION_WORK_DIRECTORY_TIMEOUTS.TITLE_WAIT_MS - 1);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const directory = await result;
    expect(path.basename(directory)).toBe('任务_1113_逐份摘要并写入 notes');
    expect(signal?.aborted).toBe(true);
    expect(log.info).toHaveBeenCalledExactlyOnceWith('Task folder title source=rule elapsedMs=3000 reason=timeout');
    console.log(log.info.mock.calls[0][0]);
    complete?.({ success: true, content: '迟到的摘要' });
    await vi.advanceTimersByTimeAsync(1);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back on an exception and removes the timer on fast success or failure', async () => {
    vi.useFakeTimers();
    await planSessionWorkDirectory({ userMessage: rr85, askTitle: async () => { throw new Error('offline'); }, now, env });
    expect(log.info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('reason=error'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['（', '(', '【', '[', '：', ':', '、', '｛'])('cleans dirty short clauses containing %s', async delimiter => {
    const result = await planSessionWorkDirectory({ userMessage: `整理合同${delimiter}附件`, now, env });
    expect(path.basename(result)).toBe('任务_1113_整理合同');
    expect(log.info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('source=rule'));
  });

  it.each(['/tmp/x', 'https://example.com/docs', '`/tmp/x`', 'C:\\docs\\x', 'sub/notes.md'])('drops the entire token %s before sanitizing', async token => {
    const result = await planSessionWorkDirectory({ userMessage: `请整理 ${token} 合同`, now, env });
    expect(path.basename(result)).toBe('任务_1113_整理 合同');
  });

  it('② rule-path names for the three original sentences are complete phrases with no holes (zh + en)', async () => {
    const names = [];
    for (const [userMessage, , ruleTitle, language] of cases) {
      const name = path.basename(await planSessionWorkDirectory({ userMessage, now, env, language }));
      const title = name.replace(/^(任务|Task)_1113_/, '');
      expect(title).toBe(ruleTitle);
      expect(title).not.toMatch(DANGLING_END);
      expect(title).not.toMatch(HOLE);
      names.push(name);
    }
    expect(names).toEqual(['任务_1113_逐份摘要并写入 notes', '任务_1113_untitled', 'Task_1113_organize all the contracts']);
  });

  it.each(['unavailable', 'timeout', 'deferModelTitle'] as const)('③ %s fallback branch names every original sentence with a complete phrase', async (branch) => {
    vi.useFakeTimers();
    for (const [userMessage, , ruleTitle, language] of cases) {
      log.info.mockClear();
      const askTitle = branch === 'unavailable' ? undefined : vi.fn(() => new Promise<{ success: boolean; content: string }>(() => {}));
      const pending = planSessionWorkDirectory({ userMessage, askTitle, deferModelTitle: branch === 'deferModelTitle', now, env, language });
      await vi.advanceTimersByTimeAsync(SESSION_WORK_DIRECTORY_TIMEOUTS.TITLE_WAIT_MS);
      const title = path.basename(await pending).replace(/^(任务|Task)_1113_/, '');
      expect(title).toBe(ruleTitle);
      expect(title).not.toMatch(DANGLING_END);
      expect(title).not.toMatch(HOLE);
      const reason = branch === 'deferModelTitle' ? 'deferred-native-turn' : branch;
      expect(log.info).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(new RegExp(`source=rule elapsedMs=\\d+ reason=${reason}$`)));
      if (branch === 'deferModelTitle') expect(askTitle).not.toHaveBeenCalled();
    }
  });

  it('④ strips a leading bare 把 from the rule folder name', async () => {
    const result = await planSessionWorkDirectory({ userMessage: '把上次的报告再补充一下数据来源', now, env });
    expect(path.basename(result)).toBe('任务_1113_上次的报告再补充一下数据来源');
    expect(log.info).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/source=rule elapsedMs=\d+ reason=unavailable/));
  });

  it.each([
    ['请整理 /tmp/x 合同', 'zh', '任务_1113_整理 合同'],
    ['Please organize /tmp/x contracts and summarize them for the team', 'en', 'Task_1113_organize contracts'],
  ] as const)('a path token between two content words just collapses: %s', async (userMessage, language, expected) => {
    expect(path.basename(await planSessionWorkDirectory({ userMessage, now, env, language }))).toBe(expected);
  });

  it.each([
    ['整理 /tmp/a 的会议记录，输出摘要', '任务_1113_untitled'],
    ['整理 /tmp/a 的会议记录，请输出摘要', '任务_1113_输出摘要'],
    ['合同文件夹已经整理好了吗（共 30 份），帮我逐份写摘要', '任务_1113_逐份写摘要'],
  ] as const)('rejects a hole next to a particle or a non-task clause: %s', async (userMessage, expected) => {
    expect(path.basename(await planSessionWorkDirectory({ userMessage, now, env }))).toBe(expected);
  });

  it('does not mistake the provisional web title for a usable smart title', async () => {
    const askTitle = vi.fn(async () => ({ success: true, content: '合同文件夹逐份摘要' }));
    const result = await planSessionWorkDirectory({ sessionTitle: rr85.slice(0, 30) + '...', userMessage: rr85, askTitle, now, env });
    expect(path.basename(result)).toBe('任务_1113_合同文件夹逐份摘要');
    expect(askTitle).toHaveBeenCalledOnce();
  });

  it('⑥ never renames a materialized model-named folder in later preflight', async () => {
    const current = await planSessionWorkDirectory({ userMessage: rr85, askTitle: async () => ({ success: true, content: '合同文件夹逐份摘要' }), now, env });
    await materializeSessionWorkDirectory(current);
    await writeFile(path.join(current, 'notes.md'), 'contract summaries');
    expect(await maybeReplanSessionWorkDirectory({ workingDirectory: current, sessionTitle: '合同风险评估', userMessage: rr85, env })).toBeUndefined();
    expect(await readdir(path.dirname(current))).toEqual([path.basename(current)]);
    expect(await readdir(current)).toEqual(['notes.md']);
  });

  it('skips the model for an existing smart title or attachment-only request', async () => {
    const askTitle = vi.fn();
    expect(path.basename(await planSessionWorkDirectory({ sessionTitle: '合同摘要', userMessage: rr85, askTitle, now, env }))).toBe('任务_1113_合同摘要');
    expect(path.basename(await planSessionWorkDirectory({ attachments: [{ name: 'budget.xlsx', category: 'data' }], askTitle, now, env }))).toBe('任务_1113_budget');
    expect(askTitle).not.toHaveBeenCalled();
  });
});

describe('workspace model title instruction window', () => {
  const longSources = [
    '周一的读书会上，大家先讨论了新版借阅规则。馆员给第一次参加的人讲了怎样在手机上看自己的借阅期限，之后又安排两位志愿者在服务台轮流答疑。会上提到，上月小程序会在归还日期前一天生成提醒，但有同学关闭了消息通知，所以纸质书签上的日期仍需保留。几位家长希望周末也能续借，值班同事会先了解周六的客流，再把结果带到下周会上。开放时间先按原安排执行，周五下班前会在服务台贴一张提醒。活动结束以后还有几位听众留下来问能不能跨馆还书，馆员建议他们先查看借书时收到的短信，再联系对应的分馆确认。',
    'At Monday’s rehearsal, the cast spent most of the evening on the quieter scenes. The stage crew said the new build of the cue app can run offline. Next week everyone will bring headphones so the sound lead can check levels without interrupting the reading. The room is booked until nine in the evening.',
    '社区食堂这周午餐照常供应，志愿者到岗后先检查冰箱温度，再去门口挂起当天菜单。周三下雨，排队的人都挪到了走廊里，几位老人来得较晚，桌边的座位已经坐满。值班负责人建议为节假日创建独立排班表，以免换班消息混在平日通知里。周五来送米的师傅会提早半小时到，负责收货的人要记得问清下个月的送货日期。订餐电话一直开到上午十点半，有临时取消的名额由前台直接登记。负责人还请大家下周带上旧的保温袋，收餐完毕后一并分给临时过来取饭的志愿者。晚上离开前，最后一班记得关上窗户，并把桌面和走道检查一遍。',
    'The park group met beside the west entrance after the rain. The city showed a design for a wider path along the pond. Most neighbors asked to keep the old benches and leave enough room for the Saturday market. A second walk is planned for next month once the water level returns to normal.',
    '本月巡河从东岸桥下开始，志愿者先记录了几处新出现的浅滩，再到下游看去年补种的水草有没有返青。早上风比较大，原定在桥头的集合改到了公交站旁边。途中有居民问到附近的旧仓库将来是否会开发为社区活动室，街道工作人员说还在收集周边居民的意见。回程时大家发现南侧步道的栏杆松了，拍照后把地点交给维护组。下次巡查暂定在月底，时间要等水位预报出来再确认。两位第一次参加的居民留了联系方式，希望下一次能从东边的湿地入口出发。维护组会先看那里的砖面是否还湿滑，确认路线以后再通知大家。',
    'The school council met to review how families hear about evening events. The office said it could generate a weekly calendar if the details arrive by Thursday. Several families asked to keep the paper notice by the main doors. The council will revisit the question after the winter concert.',
  ];

  it.each(longSources)('defers naming for a summary of pasted notes (case %#)', (source) => {
    expect(needsWorkspaceModelTitleForDeliverable(`Summarize this for me:\n\n${source}`)).toBe(false);
  });

  it.each([
    ['head', `做一个关于社区阅读活动的网页\n\n${longSources[0]}`],
    ['tail', `${longSources[0]}\n\n请将摘要保存到 x.md`],
  ])('keeps model naming for a deliverable instruction at the %s', (_edge, prompt) => {
    expect(needsWorkspaceModelTitleForDeliverable(prompt)).toBe(true);
  });

  it.each([
    ['Summarize these notes', false],
    ['帮我总结这段话', false],
    ['Build a landing page', true],
    ['请把摘要保存到 x.md', true],
    ['用 Excel 做预算表', true],
    ['Summarize the design notes', true],
    [`${'A'.repeat(93)} build ${'A'.repeat(92)}`, true],
  ] as const)('preserves the result for short prompt %s', (prompt, expected) => {
    expect(needsWorkspaceModelTitleForDeliverable(prompt)).toBe(expected);
  });

  it('plans a rule-titled folder using the original summary instruction', async () => {
    const userMessage = `Summarize this for me:\n\n${longSources[0]}`;
    const askTitle = vi.fn();
    const folder = await planSessionWorkDirectory({
      userMessage,
      deferModelTitle: !needsWorkspaceModelTitleForDeliverable(userMessage),
      askTitle,
      env,
      now,
      language: 'en',
    });
    expect(path.basename(folder)).toBe('Task_1113_Summarize this for me');
    expect(askTitle).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/source=rule elapsedMs=\d+ reason=deferred-native-turn/));
  });
});
