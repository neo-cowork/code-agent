// 故障注入：让 FSWatcher.close 同步卡 300ms（模拟 fseventsd 繁忙），经 watchdog 模块入口
// 验证：dispose()（仍会 close）产生一条带 SkillWatcher 线索的 stall 警告；工作区切换不产生。
import * as fs from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warns = vi.hoisted(() => [] as Array<{ message: string; data: Record<string, unknown> }>);

vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: (context: string) => {
      const real = actual.createLogger(context);
      if (context !== 'EventLoopWatchdog') return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'warn') {
            return (message: string, data?: Record<string, unknown>) => { warns.push({ message, data: data ?? {} }); };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

import { startEventLoopWatchdog } from '../../../src/web/eventLoopWatchdog';
import { getSkillWatcher, resetSkillWatcher } from '../../../src/host/services/skills/skillWatcher';

const BLOCK_MS = 300;
const WINDOW_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('event loop watchdog × SkillWatcher (fault injection)', () => {
  let tempHome: string;
  const prior: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'loop-watchdog-'));
    for (const key of ['CODE_AGENT_HOME', 'CODE_AGENT_DATA_DIR', 'CODE_AGENT_LOOP_WATCHDOG_MS', 'CODE_AGENT_LOOP_WATCHDOG_WINDOW_MS']) {
      prior[key] = process.env[key];
    }
    process.env.CODE_AGENT_HOME = tempHome;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempHome, 'nested', '.code-agent');
    process.env.CODE_AGENT_LOOP_WATCHDOG_MS = '100';
    process.env.CODE_AGENT_LOOP_WATCHDOG_WINDOW_MS = String(WINDOW_MS);
    warns.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetSkillWatcher();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it('dispose() stalls once and is attributed to SkillWatcher; project switches stay silent', async () => {
    const dirA = path.join(tempHome, 'task-A');
    const dirB = path.join(tempHome, 'task-B');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const watcher = getSkillWatcher();
    await watcher.initialize(dirA);

    const probe = fs.watch(tempHome);
    const proto = Object.getPrototypeOf(probe) as { close(this: unknown): void };
    probe.close();
    const realClose = proto.close;
    vi.spyOn(proto, 'close').mockImplementation(function (this: unknown) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BLOCK_MS);
      return realClose.call(this);
    });

    startEventLoopWatchdog();
    await sleep(WINDOW_MS + 200);   // 冲掉启动期的窗口
    warns.length = 0;

    for (let i = 0; i < 10; i++) {
      await watcher.updateProjectDirectory(i % 2 === 0 ? dirB : dirA);
    }
    await sleep(WINDOW_MS * 2 + 200);
    expect(warns).toEqual([]);

    await watcher.dispose();   // 仍会 close 三个常驻 watcher：3 × 300ms 同步阻塞
    await sleep(WINDOW_MS * 2 + 200);
    expect(warns).toHaveLength(1);
    const [{ message, data }] = warns;
    expect(message).toBe('[loop-watchdog] event loop stalled');
    expect(data.max_ms as number).toBeGreaterThanOrEqual(BLOCK_MS);
    expect(data.skill_watcher_slowest_op).toMatchObject({ op: expect.stringMatching(/^close-watcher |^stop$/) });
    // 取证用：设置 WATCHDOG_EVIDENCE_OUT 时把原始警告行落盘（测试 setup 会吞 console）
    if (process.env.WATCHDOG_EVIDENCE_OUT) fs.writeFileSync(process.env.WATCHDOG_EVIDENCE_OUT, `${JSON.stringify({ message, ...data })}\n`);
  });
});
