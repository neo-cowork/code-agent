import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  materializeSessionWorkDirectory, maybeReplanSessionWorkDirectory, planSessionWorkDirectory,
} from '../../../../src/host/config/sessionWorkDirectory';
import { SESSION_WORK_DIRECTORY_TIMEOUTS } from '../../../../src/shared/constants/timeouts';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../../../../src/host/services/infra/logger', () => ({ createLogger: () => log }));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));

const rr85 = '我把合同文件夹整个拖进来了（共 30 份：PDF、Excel 表、图片、文本都有），请逐份摘要并写入 notes.md';
const cases = [
  [rr85, '合同文件夹逐份摘要', '合同文件夹整个拖进来了', 'zh'],
  ['请帮我整理 `/tmp/contracts` 和 /tmp/notes 的会议记录（附原始资料），输出摘要', '会议记录摘要', '整理 和 的会议记录', 'zh'],
  ['Please help me organize all the contracts and produce a detailed summary for the team (thirty documents)', 'Contract collection summary', 'organize all the', 'en'],
] as const;
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
    expect(path.basename(result)).toBe('任务_1113_合同文件夹整个拖进来了');
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
    expect(path.basename(directory)).toBe('任务_1113_合同文件夹整个拖进来了');
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

  // N-FIX-TELEMETRY-RECOVERY-NOTICE-RESIDUE-SKILLDRAFT-TITLE：文件夹命名与标题
  // 共用恢复提示清洗入口；只剩提示的消息按空消息处理（附件名/untitled 兜底）。
  describe('first-turn message carries the legacy recovery notice', () => {
    const LEGACY_NOTICE =
      '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';

    it('folder title comes from the real text (model and rule paths)', async () => {
      const askTitle = vi.fn(async (_prompt: string, _signal: AbortSignal) => ({ success: true, content: '会议纪要周报' }));
      const model = await planSessionWorkDirectory({
        userMessage: `${LEGACY_NOTICE}\n\n帮我把三页会议纪要整理成一份周报发给团队`,
        askTitle, now, env,
      });
      expect(path.basename(model)).toBe('任务_1113_会议纪要周报');
      expect(askTitle).toHaveBeenCalledOnce();
      expect(String(askTitle.mock.calls[0][0])).not.toMatch(/历史恢复提示|telemetry|重建|脱敏/);

      const rule = await planSessionWorkDirectory({
        userMessage: `${LEGACY_NOTICE}\n\n帮我把三页会议纪要整理成一份周报发给团队`,
        now, env,
      });
      expect(path.basename(rule)).toBe('任务_1113_把三页会议纪要整理成一份周报发给团队');
    });

    it('a notice-only message behaves like an empty message: attachment name or untitled, never the notice', async () => {
      const askTitle = vi.fn();
      const withAttachment = await planSessionWorkDirectory({
        userMessage: `${LEGACY_NOTICE}\n\n`,
        attachments: [{ name: 'weekly-notes.xlsx', category: 'data' }],
        askTitle, now, env,
      });
      expect(path.basename(withAttachment)).toBe('任务_1113_weekly-notes');
      const bare = await planSessionWorkDirectory({ userMessage: LEGACY_NOTICE, askTitle, now, env });
      expect(path.basename(bare)).toBe('任务_1113_untitled');
      expect(askTitle).not.toHaveBeenCalled();
      expect(`${path.basename(withAttachment)}${path.basename(bare)}`).not.toMatch(/历史恢复提示|telemetry|重建|脱敏/);
    });
  });
});
