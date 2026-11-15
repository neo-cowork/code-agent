import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CHILD = path.join(__dirname, 'shellBridgeProduction.child.ts');
const bridgeVars = ['CODE_AGENT_ENV_ASSIST_BRIDGE_URL', 'CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN', 'CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE'];
const panes = ['accessibility', 'screenCapture', 'inputMonitoring', 'automation'];
const routes = ['accessibility', 'screen', 'input', 'automation'];

describe.skipIf(process.platform !== 'darwin')('real stdin -> production host bridge entries', () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function stub() {
    const token = randomBytes(32).toString('hex');
    const requests: Array<{ method: string; path: string; authorized: boolean; body: unknown }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        const authorized = req.headers.authorization === `Bearer ${token}`;
        requests.push({ method: req.method!, path: req.url!, authorized, body: JSON.parse(body || '{}') });
        res.setHeader('Content-Type', 'application/json');
        if (!authorized) { res.writeHead(401).end('{}'); return; }
        const response = req.url?.startsWith('/v1/grant/') ? { requested: true }
          : req.url === '/v1/passive/accessibility' ? { trusted: false }
          : req.url === '/v1/passive/screen' ? { granted: false }
          : { code: req.url === '/v1/passive/input' ? 2 : -1744 };
        res.end(JSON.stringify(response));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }));
    return { token, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
  }

  async function run(mode: string, bridge?: { url: string; token: string }): Promise<string> {
    // A clean harness env keeps raw `env` evidence free of unrelated user secrets/paths.
    const home = mkdtempSync('/tmp/env-assist-host-');
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', CHILD, mode], {
      cwd: process.cwd(), env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: '/tmp',
        SHELL: '/bin/bash', CODE_AGENT_CLI_MODE: '1', CODE_AGENT_NO_RUNTIME_AUTOINSTALL: '1',
        CODE_AGENT_DATA_DIR: path.join(home, 'data'),
        ...(bridge ? { CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE: '1' } : {}),
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 40000);
    try {
      child.stdin.end(bridge ? `CODE_AGENT_ENV_ASSIST_BRIDGE ${bridge.url} ${bridge.token}\n` : '');
      expect(await done, err).toBe(0);
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  it('Bash createHandler().execute foreground env contains no bridge vars or secret after real stdin capture', async () => {
    const bridge = await stub();
    const out = await run('bash', bridge);
    const record = JSON.parse(out.match(/^BASH (.*)$/m)![1]);
    expect(record.hasClient).toBe(true);
    expect(record.result.ok).toBe(true);
    const env = record.result.output as string;
    expect(env).toContain('PATH=');
    for (const name of bridgeVars) expect(env).not.toContain(name);
    expect(env).not.toContain(bridge.token);
    expect(bridge.requests).toEqual([]);
    process.stdout.write(`[Bash foreground env raw]\n${env}\n[Bash isolation] bridge vars absent; token absent; hasClient=true\n`);
  }, 60000);

  it('zero-arg registerEnvAssistHandlers: each pane checks with exactly one grant POST and passive-only follow-up', async () => {
    const bridge = await stub();
    const out = await run('grant', bridge);
    const clicks = [...out.matchAll(/^CLICK (.*)$/gm)].map((m) => JSON.parse(m[1]));
    process.stdout.write(`${clicks.map((c) => `CLICK ${JSON.stringify(c)}`).join('\n')}\n[production request log] ${JSON.stringify(bridge.requests)}\n`);
    expect(clicks.map((c) => c.pane)).toEqual(panes);
    for (const click of clicks) {
      expect(click.response).toMatchObject({ success: true, data: { status: 'checked' } });
    }
    const expected = routes.flatMap((route) => [
      ...(route === 'automation' ? [`/v1/passive/${route}`] : []),
      `/v1/grant/${route}`, `/v1/passive/${route}`,
    ]);
    expect(bridge.requests.map((r) => r.path)).toEqual(expected);
    for (const route of routes) {
      expect(bridge.requests.filter((r) => r.path === `/v1/grant/${route}`)).toHaveLength(1);
    }
    expect(bridge.requests.every((r) => r.authorized && r.method === 'POST')).toBe(true);
    expect(bridge.requests.filter((r) => r.path.endsWith('/automation')).map((r) => r.body))
      .toEqual(Array(3).fill({ targetBundleId: 'com.apple.iCal' }));
  }, 60000);

  it('diagnostic-only probes issue zero grant POSTs; no-handshake control returns not_available through the same route', async () => {
    const bridge = await stub();
    const out = await run('diagnostic', bridge);
    const diagnosis = JSON.parse(out.match(/^DIAGNOSTIC (.*)$/m)![1]);
    expect(diagnosis.hasClient).toBe(true);
    expect(diagnosis.outcomes.map((o: { status: string }) => o.status)).toEqual(['denied', 'denied', 'undecided', 'undecided']);
    expect(bridge.requests.filter((r) => r.path.startsWith('/v1/grant/'))).toHaveLength(0);
    expect(bridge.requests.map((r) => r.path).sort()).toEqual(routes.map((r) => `/v1/passive/${r}`).sort());
    process.stdout.write(`DIAGNOSTIC ${JSON.stringify(diagnosis)}\n[diagnostic request log] ${JSON.stringify(bridge.requests)} grants=0\n`);
    const count = bridge.requests.length;
    const control = await run('no-env');
    const clicks = [...control.matchAll(/^CLICK (.*)$/gm)].map((m) => JSON.parse(m[1]));
    expect(clicks.map((c) => c.pane)).toEqual(panes);
    for (const click of clicks) {
      expect(click.response).toMatchObject({ success: true, data: { status: 'not_available' } });
      process.stdout.write(`[no-env control] ${JSON.stringify(click)}\n`);
    }
    expect(bridge.requests).toHaveLength(count);
  }, 60000);
});
