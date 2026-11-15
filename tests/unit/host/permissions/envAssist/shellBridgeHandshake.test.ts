import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CHILD = path.join(__dirname, 'shellBridgeHandshake.child.ts');
const TOKEN = 'handshake-secret-token-0123456789abcdef';

interface Stub {
  url: string;
  auths: string[];
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const auths: string[] = [];
  const server = http.createServer((req, res) => {
    auths.push(String(req.headers.authorization));
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'denied' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    auths,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function startChild(): { child: ChildProcessWithoutNullStreams; out: () => string; err: () => string } {
  const env: NodeJS.ProcessEnv = { ...process.env, CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE: '1' };
  delete env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL;
  delete env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN;
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, TOKEN.slice(0, 16)], { env, cwd: process.cwd() });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { err += c.toString(); });
  return { child, out: () => out, err: () => err };
}

async function waitFor(pred: () => boolean, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout waiting for child output');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(process.platform !== 'darwin')('shell bridge stdin handshake (real child process)', () => {
  const stubs: Stub[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  afterEach(async () => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
    for (const s of stubs.splice(0)) await s.close();
  });

  it('resolves the bridge from the first stdin line, keeps token out of env, and leaves later stdin bytes readable', async () => {
    const stub = await startStub();
    stubs.push(stub);
    const run = startChild();
    children.push(run.child);
    run.child.stdin.write(`CODE_AGENT_ENV_ASSIST_BRIDGE ${stub.url} ${TOKEN}\n`);
    await waitFor(() => run.out().includes('RESULT '));
    run.child.stdin.write('after-handshake\n');
    await waitFor(() => run.out().includes('REST '));
    const result = JSON.parse(run.out().match(/RESULT (.*)\n/)![1]);
    expect(result).toEqual({ hasClient: true, envLeak: false, postOk: true });
    expect(stub.auths).toEqual([`Bearer ${TOKEN}`]);
    expect(JSON.parse(run.out().match(/REST (.*)\n/)![1])).toBe('after-handshake\n');
    process.stdout.write(`[handshake child] ${run.out().trim().replace(/\n/g, ' | ')}\n`);
  }, 40000);

  it('ps eww cannot see the token for a handshake child', async () => {
    const stub = await startStub();
    stubs.push(stub);
    const run = startChild();
    children.push(run.child);
    run.child.stdin.write(`CODE_AGENT_ENV_ASSIST_BRIDGE ${stub.url} ${TOKEN}\n`);
    await waitFor(() => run.out().includes('RESULT '));
    const ps = spawnSync('ps', ['eww', '-o', 'command=', '-p', String(run.child.pid)], { encoding: 'utf8' });
    expect(ps.stdout.length).toBeGreaterThan(0);
    expect(ps.stdout).not.toContain(TOKEN);
    expect(ps.stdout).toContain('CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE=1');
    process.stdout.write(`[ps eww] token_visible=${ps.stdout.includes(TOKEN)} bytes=${ps.stdout.length}\n`);
  }, 40000);

  it('malformed handshake -> null client and handshake_invalid warn', async () => {
    const run = startChild();
    children.push(run.child);
    run.child.stdin.write('garbage line without prefix\n');
    await waitFor(() => run.out().includes('RESULT '));
    expect(JSON.parse(run.out().match(/RESULT (.*)\n/)![1])).toEqual({ hasClient: false, envLeak: false, postOk: false });
    expect(run.out() + run.err()).toContain('env_assist_bridge:handshake_invalid');
  }, 40000);
});
