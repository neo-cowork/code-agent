// 故障注入：一个永远不回 initialize 的 stdio LSP server，经 initializeLSPManager 启动。
// 结论要验证的是：请求挂起（异步 30s 定时器）本身不堵事件循环，watchdog 不应有 stall；
// 而真的发生同步阻塞时，警告行带得出 LSP 状态。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  warns: [] as Array<{ message: string; data: Record<string, unknown> }>,
  stubScript: '',
}));

vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: (context: string) => {
      const real = actual.createLogger(context);
      if (context !== 'EventLoopWatchdog') return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'warn') {
            return (message: string, data?: Record<string, unknown>) => { h.warns.push({ message, data: data ?? {} }); };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

vi.mock('../../../../src/host/lsp/installer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/lsp/installer')>();
  return {
    ...actual,
    ensureInstalled: async (opts: { name: string }) => {
      if (opts.name !== 'typescript-language-server') {
        throw new actual.LSPInstallError(opts.name, { type: 'system', installCmd: 'n/a' }, 'not installed in test');
      }
      return { command: process.execPath, args: [h.stubScript] };
    },
  };
});

import { startEventLoopWatchdog } from '../../../../src/web/eventLoopWatchdog';
import { initializeLSPManager, getLSPManager } from '../../../../src/host/lsp/manager';

const WINDOW_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LSP initialize that never answers (fault injection)', () => {
  let tempDir: string;
  const prior: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'lsp-stall-'));
    h.stubScript = path.join(tempDir, 'silent-lsp.cjs');
    // 读 stdin 但永不应答；自己 6s 后退出，免得留孤儿
    await writeFile(h.stubScript, "process.stdin.resume(); setTimeout(() => process.exit(0), 6000);\n");
    for (const key of ['CODE_AGENT_LOOP_WATCHDOG_MS', 'CODE_AGENT_LOOP_WATCHDOG_WINDOW_MS']) prior[key] = process.env[key];
    process.env.CODE_AGENT_LOOP_WATCHDOG_MS = '100';
    process.env.CODE_AGENT_LOOP_WATCHDOG_WINDOW_MS = String(WINDOW_MS);
    h.warns.length = 0;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('a pending initialize request logs no stall; a real sync block while pending shows LSP state', async () => {
    startEventLoopWatchdog();
    await sleep(WINDOW_MS + 150);
    h.warns.length = 0;

    const pending = initializeLSPManager(tempDir);
    pending.catch(() => undefined);

    await sleep(WINDOW_MS * 4);
    expect(getLSPManager()).not.toBeNull();
    expect(h.warns).toEqual([]);

    // 对照：同步阻塞 400ms，警告行里应带出 LSP 初始化中的工作区与挂起请求数
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    await sleep(WINDOW_MS * 2 + 100);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0].data).toMatchObject({ lsp_initializing_workspace: tempDir, lsp_pending_requests: 1 });
    if (process.env.WATCHDOG_EVIDENCE_OUT) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(process.env.WATCHDOG_EVIDENCE_OUT, `${JSON.stringify({ message: h.warns[0].message, ...h.warns[0].data })}\n`);
    }
  });
});
