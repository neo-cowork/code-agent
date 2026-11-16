import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { devSlotBundleId, devSlotDataDirName, devSlotProductName, devSlotWebPort } from '../../src/shared/devSlot';
import {
  createIdleTracker,
  createSendTracker,
  devSlotInfo,
  isAtBottom,
  parseArgs,
  parseScenario,
  parseTarget,
  pickModelOptions,
  preflightScenario,
  readLogsSince,
  runSteps,
  targetConflict,
  visibilityVerdict,
  // @ts-expect-error —— 纯 JS 测试工具入口，无类型声明
} from '../../scripts/neo-drive/neo-drive.mjs';

type Sample = { t: number; running: boolean; cards: string[] };

function feed(track: (s: Sample) => { done: boolean; state?: string }, samples: Sample[]) {
  let last: { done: boolean; state?: string } = { done: false };
  for (const s of samples) {
    last = track(s);
    if (last.done) return { ...last, at: s.t };
  }
  return last;
}

describe('neo-drive 纯逻辑', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('目标串按前缀解析，纯文本按可见文字', () => {
    expect(parseTarget('testid=turn-reply-actions')).toEqual({ kind: 'testid', value: 'turn-reply-actions' });
    expect(parseTarget('role=button:允许访问日历')).toEqual({ kind: 'role', role: 'button', name: '允许访问日历' });
    expect(parseTarget('role=button:/^允许一次/')).toEqual({ kind: 'role', role: 'button', name: /^允许一次/ });
    expect(parseTarget('role=dialog')).toEqual({ kind: 'role', role: 'dialog', name: undefined });
    expect(parseTarget('css=[data-chat-input]')).toEqual({ kind: 'css', value: '[data-chat-input]' });
    expect(parseTarget('允许')).toEqual({ kind: 'text', value: '允许' });
    expect(parseTarget('/已允许 Neo (访问|控制)/')).toEqual({ kind: 'text', value: /已允许 Neo (访问|控制)/ });
    expect(() => parseTarget('  ')).toThrow();
  });

  it('槽号派生与 src/shared/devSlot.ts 逐槽一致', () => {
    for (let slot = 1; slot <= 9; slot += 1) {
      expect(devSlotInfo(String(slot))).toEqual({
        slot,
        appName: devSlotProductName(slot),
        bundleId: devSlotBundleId(slot),
        dataDirName: devSlotDataDirName(slot),
        port: devSlotWebPort(slot),
      });
    }
    expect(devSlotInfo('')).toMatchObject({ slot: 1 });
    expect(() => devSlotInfo('10')).toThrow();
  });

  it('wait-idle：运行中消失后要连续安静满 quietMs 才算 idle，中途闪回就重新计', () => {
    const track = createIdleTracker({ seenRunning: true, quietMs: 800 });
    const r = feed(track, [
      { t: 0, running: false, cards: [] },
      { t: 500, running: true, cards: [] }, // 工具间隙闪断后又在跑
      { t: 600, running: false, cards: [] },
      { t: 1300, running: false, cards: [] },
      { t: 1400, running: false, cards: [] },
    ]);
    expect(r).toMatchObject({ done: true, state: 'idle', at: 1400 });
  });

  it('wait-idle：没见过运行中时，在 startGrace 内不收，过了才按 idle 收', () => {
    const track = createIdleTracker({ quietMs: 0, startGraceMs: 3_000 });
    expect(feed(track, [{ t: 0, running: false, cards: [] }, { t: 2_900, running: false, cards: [] }]).done).toBe(false);
    expect(track({ t: 3_100, running: false, cards: [] })).toMatchObject({ done: true, state: 'idle', sawRunning: false });
  });

  it('wait-idle：没有确认过的 send 也没给 grace 时，一直没见到运行中判 never-ran，不当 idle（11-16 真机假通过）', () => {
    const track = createIdleTracker({ quietMs: 0, startGraceMs: 3_000, requireRunning: true });
    expect(track({ t: 0, running: false, cards: [] }).done).toBe(false);
    expect(track({ t: 4_000, running: false, cards: [] })).toEqual({ done: true, state: 'never-ran' });
    const ran = createIdleTracker({ quietMs: 0, requireRunning: true });
    expect(feed(ran, [{ t: 0, running: true, cards: [] }, { t: 100, running: false, cards: [] }])).toMatchObject({ state: 'idle', sawRunning: true });
  });

  it('send：输入框被切走（模型未配置跳到设置页）时判失败并带上提示条，不因「输入框空了」判受理（11-16 真机假通过）', () => {
    const track = createSendTracker({ baselineMatches: 0, baselineToasts: ['旧提示'], goneMs: 1_000 });
    const s = { matches: 0, running: false, sendFailed: 0 };
    expect(track({ ...s, t: 0, composer: false, toasts: ['旧提示', '当前主任务模型未配置 API Key'] }).done).toBe(false);
    const r = track({ ...s, t: 1_000, composer: false, toasts: ['旧提示', '当前主任务模型未配置 API Key'] });
    expect(r).toMatchObject({ done: true, ok: false });
    expect(r.reason).toContain('当前主任务模型未配置 API Key');
    expect(r.reason).not.toContain('旧提示');
  });

  it('send：用户气泡进了列表且见过运行中才算受理；只出现其一不算，超时原因说清缺哪样', () => {
    const s = { composer: true, sendFailed: 0, toasts: [] };
    const onlyMsg = createSendTracker({ baselineMatches: 1 });
    expect(onlyMsg({ ...s, t: 0, matches: 1, running: true }).done).toBe(false); // 运行中但列表里还是旧的那条
    expect(onlyMsg({ ...s, t: 100, matches: 2, running: false }).done).toBe(true); // 前面见过运行中 + 新气泡
    const noRun = createSendTracker({ baselineMatches: 0 });
    expect(noRun({ ...s, t: 0, matches: 1, running: false }).done).toBe(false);
    expect(noRun.timeoutReason()).toContain('一直没进入运行中');
    const noMsg = createSendTracker({ baselineMatches: 0 });
    expect(noMsg({ ...s, t: 0, matches: 0, running: false }).done).toBe(false);
    expect(noMsg.timeoutReason()).toContain('没出现在消息列表里');
    expect(createSendTracker()({ ...s, t: 0, matches: 1, running: false, sendFailed: 1 })).toMatchObject({ done: true, ok: false });
    // 会话里早先就有一条发送失败的气泡：回车前已在的标记不算，这次照常受理
    const oldFail = createSendTracker({ baselineMatches: 0, baselineFailed: 1 });
    expect(oldFail({ ...s, t: 0, matches: 1, running: true, sendFailed: 1 })).toEqual({ done: true, ok: true });
  });

  it('wait-idle：新出现的需人卡片立即返回 needs-user，开始前就在的卡不算', () => {
    const track = createIdleTracker({ baselineCards: ['old-card'], seenRunning: true });
    expect(track({ t: 0, running: true, cards: ['old-card'] }).done).toBe(false);
    expect(track({ t: 100, running: true, cards: ['old-card', 'new-card'] })).toEqual({ done: true, state: 'needs-user', cards: ['new-card'] });
  });

  it('wait-idle：新出现的运行失败卡优先判 error（不当 idle），开始前就在的失败卡不算', () => {
    const track = createIdleTracker({ baselineErrors: ['旧失败'], seenRunning: true, quietMs: 0 });
    expect(track({ t: 0, running: true, cards: [], errors: ['旧失败'] }).done).toBe(false);
    expect(track({ t: 100, running: false, cards: ['new-card'], errors: ['旧失败', '这个模型用不了：账号没通过授权'] }))
      .toEqual({ done: true, state: 'error', errors: ['这个模型用不了：账号没通过授权'] });
  });

  it('wait-idle：同会话第二张同文案失败卡也算新出现（按出现次数做基线）', () => {
    const track = createIdleTracker({ baselineErrors: ['这个模型用不了'], seenRunning: true, quietMs: 0 });
    expect(track({ t: 0, running: false, cards: [], errors: ['这个模型用不了', '这个模型用不了'] }))
      .toEqual({ done: true, state: 'error', errors: ['这个模型用不了'] });
  });

  it('select-model：显示名/模型 id 精确匹配，跨服务商同名要「服务商/模型名」才唯一（11-16 真机点错到小米）', () => {
    const rows = [
      { label: 'mimo-v2.5-pro', modelId: 'mimo-v2.5-pro', provider: 'TokenRhythm' },
      { label: 'MiMo v2.5 Pro', modelId: 'mimo-v2.5-pro', provider: '小米 MiMo' },
      { label: 'MiMo v2.6 Flash', modelId: 'mimo-v2.6-flash', provider: '小米 MiMo' },
      { label: 'claude-opus-4-8', modelId: 'anthropic/claude-opus-4-8', provider: 'CommonStack Claude' },
    ];
    expect(pickModelOptions(rows, 'mimo-v2.5-pro')).toHaveLength(2);
    expect(pickModelOptions(rows, 'TokenRhythm/mimo-v2.5-pro')).toEqual([rows[0]]);
    expect(pickModelOptions(rows, 'MiMo v2.6 Flash')).toEqual([rows[2]]);
    expect(pickModelOptions(rows, 'MiMo v2.6')).toEqual([]); // 不做子串匹配
    expect(pickModelOptions(rows, 'anthropic/claude-opus-4-8')).toEqual([rows[3]]); // 模型 id 自带 / 时先整串匹配
  });

  it('常驻浏览器与命令行显式目标不一致时报冲突，不静默沿用旧目标', () => {
    const dev1 = { url: 'http://127.0.0.1:8181', devSlot: 1 };
    const slotless = { url: 'http://127.0.0.1:52866', slotlessDataDir: '/tmp/x' };
    expect(targetConflict(dev1, { dev: '2' })).toBe('--dev=2');
    expect(targetConflict(dev1, { slot: '2' })).toBe('--slot 2');
    expect(targetConflict(slotless, { dev: '' })).toBe('--dev=1');
    expect(targetConflict(dev1, { slotless: '' })).toBe('--slotless');
    expect(targetConflict(slotless, { url: 'http://127.0.0.1:9999' })).toBe('--url http://127.0.0.1:9999');
    expect(targetConflict(dev1, { dev: '' })).toBeNull();
    expect(targetConflict(dev1, {})).toBeNull();
    expect(targetConflict(null, { dev: '2' })).toBeNull();
  });

  it('assert-visible：完全在视口与滚动容器内且未被遮挡才过', () => {
    const viewport = { width: 1440, height: 900 };
    const rect = { top: 600, bottom: 640, left: 100, right: 300, width: 200, height: 40 };
    const clip = { top: 50, bottom: 700, left: 0, right: 1440 };
    const okHits = [{ ok: true, by: 'div' }, { ok: true, by: 'div' }, { ok: true, by: 'div' }];
    expect(visibilityVerdict({ rect, viewport, clip, hits: okHits })).toEqual({ ok: true });
    // 底边伸出滚动容器（被输入框区域裁掉）
    const low = { ...rect, top: 680, bottom: 720 };
    expect(visibilityVerdict({ rect: low, viewport, clip, hits: okHits })).toMatchObject({ ok: false, reason: expect.stringContaining('滚动容器') });
    // 几何在内，但最上层命中的是输入框
    const covered = [{ ok: true, by: 'div' }, { ok: false, by: 'div[data-chat-input]' }, { ok: true, by: 'div' }];
    expect(visibilityVerdict({ rect, viewport, clip, hits: covered })).toMatchObject({ ok: false, reason: expect.stringContaining('data-chat-input') });
    expect(visibilityVerdict({ rect: { ...rect, height: 0 }, viewport, clip: null, hits: okHits }).ok).toBe(false);
    expect(visibilityVerdict({ rect: { ...rect, bottom: 901 }, viewport, clip: null, hits: okHits }).ok).toBe(false);
  });

  it('assert-bottom：离底 ≤4px 算落底', () => {
    expect(isAtBottom({ scrollHeight: 5000, scrollTop: 4100, clientHeight: 898 })).toBe(true);
    expect(isAtBottom({ scrollHeight: 5000, scrollTop: 4000, clientHeight: 898 })).toBe(false);
  });

  it('场景解析：替换 ${ts}，拒绝未知动作与空场景', () => {
    const s = parseScenario({ steps: [{ do: 'send', text: 'neo-drive 测试 ${ts}' }] }, { ts: 42 });
    expect(s.steps[0].text).toBe('neo-drive 测试 42');
    expect(() => parseScenario({ steps: [{ do: 'tap' }] })).toThrow('未知动作');
    expect(() => parseScenario({ steps: [{ do: 'open-session', sesion: 'x' }] })).toThrow('不认识的字段: sesion');
    expect(parseScenario({ steps: [{ do: 'open-session', id: 'session_1' }] }).steps[0]).toEqual({ do: 'open-session', id: 'session_1' });
    const withModel = parseScenario({ model: 'MiMo v2.6 Flash', steps: [{ do: 'new-session' }, { do: 'send', text: 'hi' }, { do: 'new-session', always: true }] });
    expect(withModel.steps.map((x: { do: string; model?: string; always?: boolean }) => [x.do, x.model ?? null, x.always ?? false])).toEqual([
      ['new-session', null, false], ['select-model', 'MiMo v2.6 Flash', false], ['send', null, false],
      ['new-session', null, true], ['select-model', 'MiMo v2.6 Flash', true],
    ]);
    expect(() => parseScenario({ steps: [] })).toThrow();
  });

  it('preflight：新会话后先切模型，再发「你好」等正常回完', () => {
    const s = parseScenario(preflightScenario('MiMo v2.6 Flash'));
    expect(s.steps.map((x: { do: string }) => x.do)).toEqual(['new-session', 'select-model', 'send', 'wait-idle']);
    expect(s.steps[3]).toMatchObject({ expect: 'idle' });
    expect(parseScenario(preflightScenario(undefined)).steps.map((x: { do: string }) => x.do)).toEqual(['new-session', 'send', 'wait-idle']);
  });

  it('runSteps：一步失败后只跑 always 清理步，整体判红', async () => {
    const ran: string[] = [];
    let t = 0;
    const out = await runSteps(
      [{ do: 'a' }, { do: 'b' }, { do: 'c' }, { do: 'cleanup', always: true }],
      async (step: { do: string }) => {
        ran.push(step.do);
        if (step.do === 'b') throw new Error('boom');
        return undefined;
      },
      () => (t += 10),
    );
    expect(ran).toEqual(['a', 'b', 'cleanup']);
    expect(out.ok).toBe(false);
    expect(out.results.map((r: { do: string; ok: boolean; skipped?: boolean }) => [r.do, r.ok, r.skipped ?? false])).toEqual([
      ['a', true, false], ['b', false, false], ['c', false, true], ['cleanup', true, false],
    ]);
    expect(out.results[1].error).toBe('boom');
  });

  it('日志增量读：只读偏移之后的新内容，新文件从头读', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'neo-drive-log-'));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, 'code-agent-2026-11-16.log'), 'old line\n');
    const first = readLogsSince(dir, {});
    const marks = first.marks;
    appendFileSync(path.join(dir, 'code-agent-2026-11-16.log'), 'Agent run completed\n');
    writeFileSync(path.join(dir, 'app-2026-11-17.log'), 'new file line\n');
    writeFileSync(path.join(dir, 'ignore.ndjson'), 'x\n');
    const next = readLogsSince(dir, marks);
    expect(next.text).toContain('Agent run completed');
    expect(next.text).toContain('new file line');
    expect(next.text).not.toContain('old line');
    expect(next.text).not.toContain('x\n');
    // 轮转/截断：文件变短后再写，要从头读到新行
    writeFileSync(path.join(dir, 'code-agent-2026-11-16.log'), 'rotated\n');
    expect(readLogsSince(dir, next.marks).text).toContain('rotated');
  });

  it('参数解析：--dev=2 / 裸 --slotless / 带值选项；未知选项报错', () => {
    expect(parseArgs(['browser', 'start', '--dev=2'])).toEqual({ opts: { dev: '2' }, pos: ['browser', 'start'] });
    expect(parseArgs(['run', 'c.json', '--slotless'])).toEqual({ opts: { slotless: '' }, pos: ['run', 'c.json'] });
    expect(parseArgs(['wait-idle', '--expect', 'needs-user', '--timeout', '5000']).opts).toEqual({ expect: 'needs-user', timeout: '5000' });
    expect(() => parseArgs(['send', '--bogus'])).toThrow('未知选项');
  });
});
