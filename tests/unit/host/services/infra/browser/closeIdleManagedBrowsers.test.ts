import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Browser, BrowserContext } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserPool } from '../../../../../../src/host/services/infra/browserPool';
import { closeIdleManagedBrowsers } from '../../../../../../src/host/services/infra/browser/closeIdleManagedBrowsers';
import type { SystemChromeCdpLaunchInput } from '../../../../../../src/host/services/infra/browser/browserLaunchHelpers';

const children: ChildProcess[] = [];
const playwrightClose = vi.fn(() => new Promise<void>(() => {}));
vi.mock('../../../../../../src/host/services/infra/browser/browserLaunchHelpers', async (original) => ({
  ...await original<object>(),
  launchSystemChromeCdpBrowser: async (input: SystemChromeCdpLaunchInput) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    await once(child, 'spawn');
    input.onProcessStart(child);
    child.once('exit', (code, signal) => input.onProcessExit(child, code, signal));
    return {
      browser: { close: playwrightClose } as unknown as Browser,
      context: { addInitScript: async () => {}, route: async () => {}, close: playwrightClose } as unknown as BrowserContext,
      executable: process.execPath, cdpPort: 0,
    };
  },
}));

async function launch(key?: string): Promise<ChildProcess> {
  await browserPool.acquire(key).launch({ provider: 'system-chrome-cdp', mode: 'headless' });
  return children.at(-1)!;
}

async function expectTerminated(child: ChildProcess): Promise<void> {
  await vi.waitFor(() => expect(child.signalCode).toBe('SIGTERM'));
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  browserPool.acquire().setLeaseInUse(false);
  await browserPool.acquire().close();
  for (const key of browserPool.listAgents()) await browserPool.releaseAgent(key);
  playwrightClose.mockClear();
});

describe('closeIdleManagedBrowsers production pool and lease guards', () => {
  it('terminates default and named idle processes including kept pages, without Playwright close or unrelated kills', async () => {
    const personal = await launch();
    const named = await launch('idle-result');
    browserPool.setKept('idle-result', true);
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(unrelated);
    const log = vi.spyOn(console, 'error');
    expect(closeIdleManagedBrowsers('shell-exit-resident')).toEqual({ closed: 2, skipped: [] });
    await Promise.all([expectTerminated(personal), expectTerminated(named)]);
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
    expect(playwrightClose).not.toHaveBeenCalled();
    expect(browserPool.hasAgent('idle-result')).toBe(true);
    const lines = log.mock.calls.filter((args) => args.some((arg) => String(arg).includes('[managed-browser.idle-close]')));
    expect(lines).toHaveLength(1);
    expect(lines[0].join(' ')).toContain('closed=2 skipped-because-in-use=0');
  });

  it('protects the default lease and named leases, then closes them after they become idle', async () => {
    const personal = await launch();
    const named = await launch('busy');
    browserPool.acquire().setLeaseInUse(true);
    browserPool.acquire('busy').setLeaseInUse(true);
    const log = vi.spyOn(console, 'error');
    expect(closeIdleManagedBrowsers('shutdown')).toEqual({
      closed: 0,
      skipped: [{ key: '__default__', reason: 'in-use' }, { key: 'busy', reason: 'in-use' }],
    });
    expect(personal.signalCode).toBeNull();
    expect(named.signalCode).toBeNull();
    expect(log.mock.calls.flat().join(' ')).toContain('skipped-because-in-use=2');
    browserPool.acquire().setLeaseInUse(false);
    browserPool.acquire('busy').setLeaseInUse(false);
    expect(closeIdleManagedBrowsers('residency-idle').closed).toBe(2);
    await Promise.all([expectTerminated(personal), expectTerminated(named)]);
  });

  it('also respects pool occupancy even if the service lease flag is clear', async () => {
    const named = await launch('pool-busy');
    browserPool.setInUse('pool-busy', true);
    expect(closeIdleManagedBrowsers('shutdown').skipped).toContainEqual({ key: 'pool-busy', reason: 'in-use' });
    expect(named.signalCode).toBeNull();
    browserPool.setInUse('pool-busy', false);
    expect(closeIdleManagedBrowsers('residency-idle').closed).toBe(1);
    await expectTerminated(named);
  });

  it('works on Windows without a sh watchdog and reports missing/dead processes on repeated calls', async () => {
    const personal = await launch();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(closeIdleManagedBrowsers('shutdown').closed).toBe(1);
      await expectTerminated(personal);
      const log = vi.spyOn(console, 'error');
      expect(closeIdleManagedBrowsers('shutdown')).toEqual({
        closed: 0, skipped: [{ key: '__default__', reason: 'no-managed-process' }],
      });
      expect(log.mock.calls.flat().join(' ')).toContain('closed=0 skipped-because-in-use=0');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
