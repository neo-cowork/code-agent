// 故障注入 × SIGTERM：在「SkillWatcher.close 同步阻塞」与「LSP initialize 永不应答」两种条件仍在发生时，
// 对子进程发 SIGTERM，断言它在限定时间内退出。
// 限定时间 = 桌面壳给 webServer 的优雅关闭宽限（src-tauri/src/main.rs GRACEFUL_SHUTDOWN_TIMEOUT = 3s，
// 到点 SIGKILL）；e2e-core 的 neo-realrun stop 同样只等有限时间就升级 kill9。
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const GRACE_MS = 3_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const tsx = path.join(repoRoot, 'node_modules/.bin/tsx');
const harness = path.join(here, 'fixtures/sigtermHarness.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

describe('SIGTERM while a fault is being injected', () => {
  let tmp: string;
  let child: ChildProcess | null = null;
  const extraPids: number[] = [];

  afterEach(async () => {
    if (child?.pid && isAlive(child.pid)) child.kill('SIGKILL');
    for (const pid of extraPids.splice(0)) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    await rm(tmp, { recursive: true, force: true });
  });

  async function startHarness(mode: 'skill-switch' | 'lsp-pending', env: Record<string, string> = {}) {
    tmp = await mkdtemp(path.join(tmpdir(), `sigterm-${mode}-`));
    const readyFile = path.join(tmp, 'ready');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    child = spawn(tsx, [harness], {
      env: {
        ...process.env,
        ...env,
        HARNESS_MODE: mode,
        HARNESS_READY_FILE: readyFile,
        HARNESS_WORK_DIR: path.join(tmp, 'work'),
        CODE_AGENT_HOME: home,
        CODE_AGENT_DATA_DIR: path.join(home, '.code-agent'),
        CODE_AGENT_LOOP_WATCHDOG: '0',
      },
      stdio: 'ignore',
    });
    fs.mkdirSync(path.join(tmp, 'work'), { recursive: true });
    const ready = await waitFor(() => fs.existsSync(readyFile), 90_000);
    expect(ready, 'harness never reported ready').toBe(true);
    // 夹具写进去的是真正跑代码的 node 进程 pid（tsx 外面还有一层包装进程）
    const serverPid = Number(fs.readFileSync(readyFile, 'utf8'));
    extraPids.push(serverPid);
    return { serverPid };
  }

  /** 对真 pid 发 SIGTERM，返回它从收到信号到进程消失的毫秒数（60s 还在就按 60s 计）。 */
  async function sigtermLatency(label: string, serverPid: number): Promise<number> {
    const sentAt = Date.now();
    process.kill(serverPid, 'SIGTERM');
    await waitFor(() => !isAlive(serverPid), 60_000);
    const latency = Date.now() - sentAt;
    if (process.env.SIGTERM_EVIDENCE_OUT) fs.appendFileSync(process.env.SIGTERM_EVIDENCE_OUT, `${label} SIGTERM→exit ${latency}ms (grace ${GRACE_MS}ms)\n`);
    return latency;
  }

  it('SkillWatcher: alternating switches with a blocking close → SIGTERM exits within the shell grace', async () => {
    const { serverPid } = await startHarness('skill-switch');
    expect(await sigtermLatency('skill-switch', serverPid)).toBeLessThanOrEqual(GRACE_MS);
  }, 180_000);

  it('LSP: initializeLSPManager pending on a never-answering stub → SIGTERM exits within the shell grace, stub not orphaned', async () => {
    // 先造垫片：which typescript-language-server 命中它，它再 exec 一个读 stdin、永不应答的 node stub
    const shimDir = fs.mkdtempSync(path.join(tmpdir(), 'lsp-shim-'));
    const stub = path.join(shimDir, 'silent-lsp.cjs');
    const stubPidFile = path.join(shimDir, 'stub.pid');
    // 与真 LSP server 一致：stdin 关闭（父进程没了）就退出；其余永不应答
    fs.writeFileSync(stub, `require('fs').writeFileSync(${JSON.stringify(stubPidFile)}, String(process.pid));\nprocess.stdin.on('end', () => process.exit(0));\nprocess.stdin.resume();\nsetTimeout(() => process.exit(0), 120000);\n`);
    fs.writeFileSync(path.join(shimDir, 'typescript-language-server'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)}\n`, { mode: 0o755 });
    try {
      const { serverPid } = await startHarness('lsp-pending', { PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}` });
      expect(await waitFor(() => fs.existsSync(stubPidFile), 30_000), 'stub never started').toBe(true);
      const stubPid = Number(fs.readFileSync(stubPidFile, 'utf8'));
      extraPids.push(stubPid);
      await sleep(500);   // 让 initialize 请求真正挂在管道上
      expect(await sigtermLatency('lsp-pending', serverPid)).toBeLessThanOrEqual(GRACE_MS);
      expect(await waitFor(() => !isAlive(stubPid), 5_000), 'stub LSP process stayed orphaned').toBe(true);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  }, 240_000);
});
