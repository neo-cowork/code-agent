/**
 * Dev 包故障注入：从生产入口（webServer 启动路径调用的加载器函数 / makeAiSdkFetch /
 * electronFetch / 连接器注册表）驱动真编译产物 dist/web/dev-fault-inject.cjs。
 * 夹具是真模块（esbuild 现编），不是手搓 mock；Dev 槽身份只来自 CODE_AGENT_DATA_DIR 目录名。
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
const axiosMock = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({
  default: Object.assign(axiosMock, { isCancel: () => false }),
}));

import {
  devFaultAfterListen,
  devFaultAtBoot,
} from '../../../src/host/services/infra/devFaultLoader';
import { makeAiSdkFetch } from '../../../src/host/model/adapters/aiSdkFetch';
import { electronFetch } from '../../../src/host/model/providers/providerHttp';
import { ConnectorRegistry } from '../../../src/host/connectors/registry';
import type { Connector } from '../../../src/host/connectors/base';

const MODULE_PATH = path.join(process.cwd(), 'dist/web/dev-fault-inject.cjs');
let hadModule = false;
let tmp: string;
let devDir: string;
let prodDir: string;
const savedEnv = { ...process.env };

function useFault(value: string | undefined, dataDir: string): void {
  if (value === undefined) delete process.env.NEO_DEV_FAULT;
  else process.env.NEO_DEV_FAULT = value;
  process.env.CODE_AGENT_DATA_DIR = dataDir;
}

function injectedLines(): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('dev_fault_inject'));
}

beforeAll(() => {
  hadModule = fs.existsSync(MODULE_PATH);
  if (!hadModule) {
    esbuild.buildSync({
      entryPoints: ['src/web/devFaultInject.ts'], outfile: MODULE_PATH,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'error',
    });
  }
});

afterAll(() => {
  if (!hadModule) fs.rmSync(MODULE_PATH, { force: true });
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-fault-'));
  devDir = path.join(tmp, '.code-agent-dev2');
  prodDir = path.join(tmp, '.code-agent');
  fs.mkdirSync(devDir);
  fs.mkdirSync(prodDir);
  warn.mockClear();
  axiosMock.mockReset();
  axiosMock.mockResolvedValue({ status: 200, headers: {}, data: '{}' });
});

afterEach(() => {
  process.env = { ...savedEnv };
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('webserver_exit_once', () => {
  it('Dev 槽：listen 后退出一次，写状态文件与一行日志；再启动不复发', () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    useFault('webserver_exit_once', devDir);
    devFaultAfterListen();
    vi.advanceTimersByTime(10_000);
    expect(exit).toHaveBeenCalledWith(1);
    expect(injectedLines()).toHaveLength(1);
    expect(injectedLines()[0]).toContain('webserver_exit_once');
    expect(fs.existsSync(path.join(devDir, 'dev-fault/exit_once.done'))).toBe(true);
    exit.mockClear();
    devFaultAfterListen();
    vi.advanceTimersByTime(10_000);
    expect(exit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('webserver_boot_fail:N', () => {
  it('前 N 次启动退出，第 N+1 次正常且计数复位', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    useFault('webserver_boot_fail:3', devDir);
    const counter = path.join(devDir, 'dev-fault/boot_fail.count');
    exit.mockImplementation((() => { throw new Error('process.exit'); }) as never);
    for (let boot = 1; boot <= 3; boot += 1) {
      expect(() => devFaultAtBoot()).toThrow('process.exit');
      expect(fs.readFileSync(counter, 'utf8')).toBe(String(boot));
    }
    expect(exit).toHaveBeenCalledTimes(3);
    expect(injectedLines()).toHaveLength(3);
    devFaultAtBoot();
    expect(exit).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(counter, 'utf8')).toBe('0');
  });

  it('与 webserver_exit_once 同列：exit_once 触发前不连败', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    useFault('webserver_exit_once,webserver_boot_fail:2', devDir);
    devFaultAtBoot();
    expect(exit).not.toHaveBeenCalled();
    exit.mockImplementation((() => { throw new Error('process.exit'); }) as never);
    fs.mkdirSync(path.join(devDir, 'dev-fault'), { recursive: true });
    fs.writeFileSync(path.join(devDir, 'dev-fault/exit_once.done'), '1');
    expect(() => devFaultAtBoot()).toThrow('process.exit');
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('offline', () => {
  it('makeAiSdkFetch 对外部地址抛离线网络错误并留痕，请求不发出；本机回环放行', async () => {
    useFault('offline', devDir);
    const fetchFn = makeAiSdkFetch('xiaomi');
    await expect(fetchFn('https://api.example.com/v1/chat/completions', { method: 'POST', body: '{}' }))
      .rejects.toMatchObject({ code: 'ENOTFOUND' });
    expect(axiosMock).not.toHaveBeenCalled();
    expect(injectedLines()).toHaveLength(1);
    expect(injectedLines()[0]).toContain('offline');
    await fetchFn('http://127.0.0.1:11434/v1/chat', { method: 'POST', body: '{}' });
    expect(axiosMock).toHaveBeenCalledTimes(1);
  });

  it('electronFetch 同样失败', async () => {
    useFault('offline', devDir);
    await expect(electronFetch('https://api.example.com/x', { method: 'GET' }))
      .rejects.toThrow(/Network request failed/);
    expect(axiosMock).not.toHaveBeenCalled();
    expect(injectedLines()[0]).toContain('offline');
  });
});

describe('connector_auth_invalid', () => {
  function stubMail(): Connector {
    return {
      id: 'mail', label: 'Mail', capabilities: ['list_accounts'],
      getStatus: async () => ({ connected: true, readiness: 'ready', capabilities: ['list_accounts'] }),
      execute: async () => ({ data: [] }),
    };
  }

  it('默认 mail：execute 抛授权被拒（AppleScript 同形），getStatus 报 not_authorized；其他连接器不受影响', async () => {
    useFault('connector_auth_invalid', devDir);
    const registry = new ConnectorRegistry('darwin');
    registry.register(stubMail());
    registry.register({ ...stubMail(), id: 'calendar' });
    const mail = registry.get('mail')!;
    await expect(mail.execute('list_accounts', {})).rejects.toMatchObject({ stderr: expect.stringContaining('-1743') });
    expect(await mail.getStatus()).toMatchObject({ connected: false, readiness: 'failed', errorCode: 'not_authorized' });
    await expect(registry.get('calendar')!.execute('x', {})).resolves.toEqual({ data: [] });
    expect(injectedLines().length).toBeGreaterThanOrEqual(2);
    expect(injectedLines()[0]).toContain('connector_auth_invalid');
  });

  it('指定 id：connector_auth_invalid:calendar 只改 calendar', async () => {
    useFault('connector_auth_invalid:calendar', devDir);
    const registry = new ConnectorRegistry('darwin');
    registry.register(stubMail());
    registry.register({ ...stubMail(), id: 'calendar' });
    await expect(registry.get('mail')!.execute('x', {})).resolves.toEqual({ data: [] });
    await expect(registry.get('calendar')!.execute('x', {})).rejects.toBeInstanceOf(Error);
  });
});

describe('非 Dev 槽数据目录：同一环境变量不起作用', () => {
  it('四种故障全部无效果、无日志', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.useFakeTimers();
    useFault('webserver_exit_once,webserver_boot_fail:3,offline,connector_auth_invalid', prodDir);
    devFaultAtBoot();
    devFaultAfterListen();
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();
    await makeAiSdkFetch('xiaomi')('https://api.example.com/v1', { method: 'POST', body: '{}' });
    expect(axiosMock).toHaveBeenCalledTimes(1);
    const registry = new ConnectorRegistry('darwin');
    registry.register({
      id: 'mail', label: 'Mail', capabilities: [],
      getStatus: async () => ({ connected: true, capabilities: [] }),
      execute: async () => ({ data: 'ok' }),
    });
    await expect(registry.get('mail')!.execute('x', {})).resolves.toEqual({ data: 'ok' });
    expect(exit).not.toHaveBeenCalled();
    expect(injectedLines()).toHaveLength(0);
    expect(fs.existsSync(path.join(prodDir, 'dev-fault'))).toBe(false);
  });
});
