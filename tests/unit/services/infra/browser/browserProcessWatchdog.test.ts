import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const MODULE = resolve(__dirname, '../../../../../src/host/services/infra/browser/browserProcessWatchdog.ts');
const TSX = resolve(__dirname, '../../../../../node_modules/.bin/tsx');

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}
function sleeper(): ChildProcess {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  cleanup.push(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  return child;
}

/** 一个一次性 node 父进程：起一个 sleep 当 Chrome 并为它启动看门狗，把两个 pid 打到 stdout。 */
async function startThrowawayServer(): Promise<{ server: { pid: number }; chromePid: number; helperPid: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'wd-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'parent.ts');
  writeFileSync(script, `
    import { spawn } from 'child_process';
    import { startChromeParentWatchdog } from ${JSON.stringify(MODULE)};
    const chrome = spawn('sh', ['-c', 'sleep 300 & wait'], { stdio: 'ignore' });
    startChromeParentWatchdog(chrome, { log: () => {} });
    setTimeout(() => { console.log(JSON.stringify({ chrome: chrome.pid, server: process.pid })); }, 500);
    setInterval(() => {}, 1000);
  `);
  const server = spawn(TSX, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  cleanup.push(() => { try { server.kill('SIGKILL'); } catch { /* gone */ } });
  const line = await new Promise<string>((res, rej) => {
    const t = setTimeout(() => rej(new Error('parent did not report pids')), 20000);
    server.stdout!.once('data', (d) => { clearTimeout(t); res(String(d)); });
  });
  const reported = JSON.parse(line) as { chrome: number; server: number };
  const chromePid = reported.chrome;
  cleanup.push(() => { try { process.kill(reported.server, 'SIGKILL'); } catch { /* gone */ } });
  const kids = await new Promise<string>((res) => {
    const p = spawn('pgrep', ['-P', String(chromePid)]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => res(out));
  });
  const helperPid = Number(kids.trim().split('\n')[0]);
  cleanup.push(() => { for (const pid of [chromePid, helperPid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  return { server: { pid: reported.server }, chromePid, helperPid };
}

describe('startChromeParentWatchdog', () => {
  it('server SIGKILLed → the stand-in Chrome and its helper die within 10s; unrelated sleep survives', async () => {
    const bystander = sleeper();
    const { server, chromePid, helperPid } = await startThrowawayServer();
    expect(alive(chromePid)).toBe(true);
    expect(alive(helperPid)).toBe(true);

    process.kill(server.pid, 'SIGKILL');

    expect(await waitUntil(() => !alive(chromePid) && !alive(helperPid), 10_000)).toBe(true);
    expect(alive(bystander.pid!)).toBe(true);
  }, 40_000);

  it('server still alive → the stand-in Chrome is left alone', async () => {
    const { server, chromePid } = await startThrowawayServer();
    await new Promise((r) => setTimeout(r, 5000));
    expect(alive(server.pid)).toBe(true);
    expect(alive(chromePid)).toBe(true);
  }, 40_000);
});
