import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { devSlotBundleId, devSlotDataDirName, devSlotProductName, devSlotWebPort } from '../../src/shared/devSlot';
import {
  createIdleTracker,
  devSlotInfo,
  isAtBottom,
  parseArgs,
  parseScenario,
  parseTarget,
  readLogsSince,
  runSteps,
  visibilityVerdict,
  // @ts-expect-error —— 纯 JS 测试工具入口，无类型声明
} from '../../scripts/neo-drive.mjs';

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

  it('wait-idle：新出现的需人卡片立即返回 needs-user，开始前就在的卡不算', () => {
    const track = createIdleTracker({ baselineCards: ['old-card'], seenRunning: true });
    expect(track({ t: 0, running: true, cards: ['old-card'] }).done).toBe(false);
    expect(track({ t: 100, running: true, cards: ['old-card', 'new-card'] })).toEqual({ done: true, state: 'needs-user', cards: ['new-card'] });
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
    expect(() => parseScenario({ steps: [] })).toThrow();
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
  });

  it('参数解析：--dev=2 / 裸 --slotless / 带值选项；未知选项报错', () => {
    expect(parseArgs(['browser', 'start', '--dev=2'])).toEqual({ opts: { dev: '2' }, pos: ['browser', 'start'] });
    expect(parseArgs(['run', 'c.json', '--slotless'])).toEqual({ opts: { slotless: '' }, pos: ['run', 'c.json'] });
    expect(parseArgs(['wait-idle', '--expect', 'needs-user', '--timeout', '5000']).opts).toEqual({ expect: 'needs-user', timeout: '5000' });
    expect(() => parseArgs(['send', '--bogus'])).toThrow('未知选项');
  });
});
