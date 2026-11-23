/**
 * offline 的其余出站口：axios（经 node:https）与 undici 直连。不 mock axios / undici，
 * 走真函数：veoRequest（axios）、createConnectorOAuthFetch（undici 代理分支）。
 * 目标主机用 .invalid（保证解析失败、不产生真实外网流量）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
}));

import { devFaultAtBoot } from '../../../src/host/services/infra/devFaultLoader';
import { veoRequest } from '../../../src/host/services/media/veoFetch';
import { createConnectorOAuthFetch } from '../../../src/host/connectors/oauth/oauthFetch';

const MODULE_PATH = path.join(process.cwd(), 'dist/web/dev-fault-inject.cjs');
let hadModule = false;
let tmp: string;
const savedEnv = { ...process.env };

function injectedLines(): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('dev_fault_inject'));
}

function useOffline(dirName: string): void {
  const dir = path.join(tmp, dirName);
  fs.mkdirSync(dir, { recursive: true });
  process.env.NEO_DEV_FAULT = 'offline';
  process.env.CODE_AGENT_DATA_DIR = dir;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
}

beforeAll(() => {
  hadModule = fs.existsSync(MODULE_PATH);
  esbuild.buildSync({
    entryPoints: ['src/web/devFaultInject.ts'], outfile: MODULE_PATH,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'error',
  });
});
afterAll(() => { if (!hadModule) fs.rmSync(MODULE_PATH, { force: true }); });
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-fault-out-')); warn.mockClear(); });
afterEach(() => { process.env = { ...savedEnv }; fs.rmSync(tmp, { recursive: true, force: true }); });

const veo = () => veoRequest('https://veo-test.invalid/v1/x', { apiKey: 'k', timeoutMs: 3000 });
const oauth = () => createConnectorOAuthFetch({ env: { HTTPS_PROXY: 'http://127.0.0.1:9' } })('https://oauth-test.invalid/token');

describe('offline：axios / undici 出站口', () => {
  it('Dev 槽：axios（veoRequest）抛离线错误并留痕', async () => {
    useOffline('.code-agent-dev2');
    devFaultAtBoot();
    await expect(veo()).rejects.toMatchObject({ code: 'ENOTFOUND' });
    expect(injectedLines().some((l) => l.includes('offline') && l.includes('node_http'))).toBe(true);
  });

  it('Dev 槽：undici 代理分支（OAuth）抛离线错误并留痕', async () => {
    useOffline('.code-agent-dev2');
    devFaultAtBoot();
    await expect(oauth()).rejects.toThrow(/ENOTFOUND/);
    expect(injectedLines().some((l) => l.includes('offline') && l.includes('outbound_request'))).toBe(true);
  });

  it('非 Dev 目录：同一变量对两个出口都不起作用（不留日志，错误不是注入的 ENOTFOUND 离线错误）', async () => {
    useOffline('.code-agent');
    devFaultAtBoot();
    await veo().catch(() => undefined);
    await oauth().catch(() => undefined);
    expect(injectedLines()).toHaveLength(0);
  });

  it('补丁常驻进程：Dev 槽测试之后切到非 Dev 目录仍无效果', async () => {
    useOffline('.code-agent-dev2');
    devFaultAtBoot();
    useOffline('.code-agent');
    await veo().catch(() => undefined);
    expect(injectedLines()).toHaveLength(0);
  });
});
