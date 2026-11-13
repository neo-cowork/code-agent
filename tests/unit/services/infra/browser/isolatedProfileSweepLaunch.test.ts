import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { MANAGED_BROWSER_ISOLATED_OWNER_FILE } from '../../../../../src/host/services/infra/browser/managedBrowserHelpers';
import { BROWSER_TIMEOUTS } from '../../../../../src/shared/constants/timeouts';

const state = vi.hoisted(() => ({ userData: '' }));
vi.mock('../../../../../src/host/platform', () => ({
  app: { getPath: () => state.userData, getAppPath: () => state.userData }, broadcastToRenderer: vi.fn(),
}));
vi.mock('../../../../../src/host/services/infra/browser/browserLaunchHelpers', () => ({
  getPlaywrightProxyOptions: vi.fn(),
  launchSystemChromeCdpBrowser: vi.fn(),
  launchPlaywrightBundledBrowser: vi.fn(async () => ({
    browser: { close: vi.fn(async () => {}) },
    context: { on: vi.fn(), close: vi.fn(async () => {}), addInitScript: vi.fn(async () => {}), route: vi.fn(async () => {}) },
    executable: 'fixture-browser', missingExecutable: false, recommendedAction: null,
  })),
}));

let scratch: string;
let root: string;
let service: import('../../../../../src/host/services/infra/browserService').BrowserService;
const old = new Date(Date.now() - BROWSER_TIMEOUTS.ISOLATED_PROFILE_SWEEP_GRACE * 2);
async function seed(name = 'stale') {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  const owner = JSON.stringify({ host: os.hostname(), pid: deadPid, processStartedAt: old.getTime() });
  await fs.writeFile(path.join(dir, 'payload'), Buffer.alloc(4096 - Buffer.byteLength(owner)));
  await fs.writeFile(path.join(dir, MANAGED_BROWSER_ISOLATED_OWNER_FILE), owner);
  await fs.utimes(path.join(dir, MANAGED_BROWSER_ISOLATED_OWNER_FILE), old, old);
  await fs.utimes(dir, old, old);
  return dir;
}
function printLogs() {
  console.log(service.logger.getLogs().filter((line) => /profile=|sweep/.test(line)).join('\n'));
}
beforeEach(async () => {
  vi.resetModules();
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-launch-test-'));
  state.userData = path.join(scratch, 'user-data');
  root = path.join(scratch, 'code-agent-managed-browser-');
  await fs.mkdir(root);
  vi.stubEnv('TMPDIR', scratch);
  const { BrowserService } = await import('../../../../../src/host/services/infra/browserService');
  service = new BrowserService('sweep-test');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await service?.close();
  vi.unstubAllEnvs();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('public BrowserService.launch isolated profile sweep wiring', () => {
  it('isolated launch removes stale profiles, prints summary, and sweeps at most once per process', async () => {
    await seed();
    const before = execFileSync('du', ['-sk', root], { encoding: 'utf8' }).trim().split(/\s/)[0];
    await service.launch({ profileMode: 'isolated', provider: 'playwright-bundled', mode: 'headless' });
    await vi.waitFor(() => expect(service.logger.getLogsAsString()).toContain('removed=1 freedBytes=4096'));
    expect((await fs.readdir(root)).filter((name) => name === 'stale')).toEqual([]);
    const [current] = await fs.readdir(root);
    const owner = JSON.parse(await fs.readFile(path.join(root, current, MANAGED_BROWSER_ISOLATED_OWNER_FILE), 'utf8'));
    expect(owner).toMatchObject({ host: os.hostname(), pid: process.pid });
    expect(owner.processStartedAt).toBeGreaterThan(0);
    expect(owner.processStartedAt).toBeLessThanOrEqual(Date.now());
    expect(await fs.readdir(path.join(root, current))).not.toContain('SingletonLock');
    const after = execFileSync('du', ['-sk', root], { encoding: 'utf8' }).trim().split(/\s/)[0];
    console.log(`public launch fixture | direct dirs | du -sk (KiB)\nbefore | 1 | ${before}\nafter | ${(await fs.readdir(root)).length} (current session) | ${after}`);
    printLogs();
    const firstLogger = service.logger;
    await service.close();
    await seed('later-leftover');
    const { BrowserService } = await import('../../../../../src/host/services/infra/browserService');
    service = new BrowserService('second-sweep-test');
    await service.launch({ profileMode: 'isolated', provider: 'playwright-bundled', mode: 'headless' });
    await vi.dynamicImportSettled();
    expect((await fs.stat(path.join(root, 'later-leftover'))).isDirectory()).toBe(true);
    expect(firstLogger.getLogs().filter((line) => line.includes('removed='))).toHaveLength(1);
    expect(service.logger.getLogs().filter((line) => line.includes('removed='))).toHaveLength(0);
  });
  it('persistent launch does NOT trigger a sweep', async () => {
    const dir = await seed();
    await service.launch({ profileMode: 'persistent', provider: 'playwright-bundled', mode: 'headless' });
    await vi.dynamicImportSettled();
    expect(service.isRunning()).toBe(true);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    expect(service.logger.getLogsAsString()).not.toContain('Isolated profile sweep');
    printLogs();
  });
  it('failing rm does not fail or delay public launch and logs WARN', async () => {
    await seed();
    let rejectDelete!: (error: Error) => void;
    const blockedDelete = new Promise<void>((_resolve, reject) => { rejectDelete = reject; });
    const rm = vi.spyOn(fs, 'rm').mockReturnValue(blockedDelete);
    await service.launch({ profileMode: 'isolated', provider: 'playwright-bundled', mode: 'headless' });
    expect(service.isRunning()).toBe(true);
    await vi.waitFor(() => expect(rm).toHaveBeenCalled());
    expect(service.logger.getLogsAsString()).not.toContain('removed=');
    console.log('Public launch resolved while sweep rm promise was still pending; isRunning=true');
    rejectDelete(new Error('injected delete denial'));
    await vi.waitFor(() => expect(service.logger.getLogsAsString()).toContain('failed=1'));
    expect(service.isRunning()).toBe(true);
    expect(service.logger.getLogsAsString()).toContain('[WARN] Isolated profile sweep failed stale: Error: injected delete denial');
    printLogs();
  });
  it('unreadable sweep root does not fail public launch and logs WARN', async () => {
    const opendir = fs.opendir.bind(fs);
    vi.spyOn(fs, 'opendir').mockImplementation(((dir: string, ...args: unknown[]) => {
      if (String(dir) === root || String(dir).endsWith('/code-agent-managed-browser-')) {
        return Promise.reject(Object.assign(new Error('injected root denied'), { code: 'EACCES' }));
      }
      return Reflect.apply(opendir, fs, [dir, ...args]);
    }) as typeof fs.opendir);
    await service.launch({ profileMode: 'isolated', provider: 'playwright-bundled', mode: 'headless' });
    await vi.waitFor(() => expect(service.logger.getLogsAsString()).toContain('failed=1'));
    expect(service.isRunning()).toBe(true);
    expect(service.logger.getLogsAsString()).toContain('[WARN] Isolated profile sweep failed root');
    printLogs();
  });
});
