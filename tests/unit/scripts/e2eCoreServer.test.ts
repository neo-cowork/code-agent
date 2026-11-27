import { describe, expect, it, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ensureServerAlive } from '../../../scripts/e2e-core/server';
import type { ServerInfo } from '../../../scripts/e2e-core/types';

function reserveClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe('ensureServerAlive (hung server recovery)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) {
      try {
        cleanups.pop()?.();
      } catch {
        /* ignore */
      }
    }
  });

  it('kills a live unresponsive pid via kill9 before restarting and returns a hang reason', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-core-server-test-'));
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    // Spawn a real live child process that does NOT serve /api/health (simulates hung server)
    const hungChild: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'], {
      detached: true,
      stdio: 'ignore',
    });
    const hungPid = hungChild.pid!;
    cleanups.push(() => {
      try {
        process.kill(-hungPid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    });

    const serverDir = path.join(tmpDir, 'server-test');
    fs.mkdirSync(serverDir, { recursive: true });
    const stateFile = path.join(serverDir, 'state.json');
    const port = await reserveClosedPort();
    fs.writeFileSync(stateFile, JSON.stringify({ pid: hungPid, port }));

    const callsLog = path.join(tmpDir, 'calls.log');
    const fakeBin = path.join(tmpDir, 'fake-neo-realrun.mjs');
    fs.writeFileSync(
      fakeBin,
      `
import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const outIdx = rest.indexOf('--out');
const outDir = outIdx >= 0 ? rest[outIdx + 1] : '';
const statePath = path.join(outDir, 'state.json');
fs.appendFileSync(${JSON.stringify(callsLog)}, cmd + '\\n');

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
if (cmd === 'kill9') {
  try { process.kill(-state.pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 40; i++) {
    try { process.kill(state.pid, 0); } catch { break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  console.log('kill9 pgid=' + state.pid);
  process.exit(0);
}
if (cmd === 'restart') {
  let stillAlive = true;
  try { process.kill(state.pid, 0); } catch { stillAlive = false; }
  if (stillAlive) {
    console.error('neo-realrun: pid ' + state.pid + ' 还活着，先 stop 或 kill9');
    process.exit(1);
  }
  console.log('started pid=99999 port=' + state.port);
  process.exit(0);
}
process.exit(2);
`,
      'utf8',
    );

    const server: ServerInfo = {
      port,
      token: 'test-token',
      home: tmpDir,
      dataDir: tmpDir,
      workspace: tmpDir,
      dir: serverDir,
      model: 'test-model',
    };

    const reason = await ensureServerAlive(fakeBin, server);
    expect(reason).not.toBeNull();
    expect(reason).toContain('卡死');
    expect(reason).toContain(String(hungPid));
    expect(reason).toContain('kill9 + restart');

    const calls = fs.readFileSync(callsLog, 'utf8').trim().split('\n');
    expect(calls).toEqual(['kill9', 'restart']);

    let childStillAlive = true;
    try {
      process.kill(hungPid, 0);
    } catch {
      childStillAlive = false;
    }
    expect(childStillAlive).toBe(false);
  });
});
