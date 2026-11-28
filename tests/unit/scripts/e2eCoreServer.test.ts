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
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
    while (cleanups.length) {
      try {
        cleanups.pop()?.();
      } catch {
        /* ignore */
      }
    }
  });

  async function runHungRecovery(shim: 'ok' | 'failing' | 'absent') {
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

    // PATH 垫片：`sample` 先于 kill9 被调用，参数里的 -file 指向 <server.dir>/hang-sample-<pid>-<ts>.txt
    const shimDir = path.join(tmpDir, 'shim');
    fs.mkdirSync(shimDir, { recursive: true });
    if (shim !== 'absent') {
      const body = shim === 'ok'
        ? `echo "sample $*" >> ${callsLog}\nwhile [ "$1" != "-file" ]; do shift; done\necho "Call graph: shim-sample" > "$2"\n`
        : `echo "sample $*" >> ${callsLog}\necho "sample: boom" >&2\nexit 7\n`;
      fs.writeFileSync(path.join(shimDir, 'sample'), `#!/bin/sh\n${body}`, { mode: 0o755 });
    }
    process.env.PATH = `${shimDir}${path.delimiter}${shim === 'absent' ? '/usr/bin-none' : originalPath}`;

    const reason = await ensureServerAlive(fakeBin, server);
    const calls = fs.readFileSync(callsLog, 'utf8').trim().split('\n');
    return { reason, calls, hungPid, serverDir };
  }

  function expectHungChildKilled(hungPid: number): void {

    let childStillAlive = true;
    try {
      process.kill(hungPid, 0);
    } catch {
      childStillAlive = false;
    }
    expect(childStillAlive).toBe(false);
  }

  it('samples the hung pid BEFORE kill9, restarts, and puts the sample path in the reason', async () => {
    const { reason, calls, hungPid, serverDir } = await runHungRecovery('ok');
    expect(reason).not.toBeNull();
    expect(reason).toContain('卡死');
    expect(reason).toContain(String(hungPid));
    expect(reason).toContain('kill9 + restart');
    expect(calls).toHaveLength(3);
    const [head, sampleFile] = calls[0].split(' -file ');
    expect(head).toBe(`sample ${hungPid} 3`);
    expect(path.dirname(sampleFile)).toBe(serverDir);
    expect(path.basename(sampleFile)).toMatch(new RegExp(`^hang-sample-${hungPid}-.+\\.txt$`));
    expect(calls.slice(1)).toEqual(['kill9', 'restart']);
    expect(fs.existsSync(sampleFile)).toBe(true);
    expect(reason).toContain(sampleFile);
    expectHungChildKilled(hungPid);
  });

  it('keeps restarting when sample fails, and says why in the console and reason', async () => {
    const { reason, calls, hungPid } = await runHungRecovery('failing');
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['sample', 'kill9', 'restart']);
    expect(reason).toContain('kill9 + restart');
    expect(reason).toContain('原生栈采样未取到');
    expectHungChildKilled(hungPid);
  });

  it('keeps restarting when sample is not on PATH', async () => {
    const { reason, calls, hungPid } = await runHungRecovery('absent');
    expect(calls).toEqual(['kill9', 'restart']);
    expect(reason).toContain('原生栈采样未取到');
    expectHungChildKilled(hungPid);
  });
});
