import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Browser, BrowserContext } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPool } from '../../../../../../src/host/services/infra/browserPool';
import { closeIdleManagedBrowsers } from '../../../../../../src/host/services/infra/browser/closeIdleManagedBrowsers';
import type { SystemChromeCdpLaunchInput } from '../../../../../../src/host/services/infra/browser/browserLaunchHelpers';
import { RunRegistry } from '../../../../../../src/host/runtime/runRegistry';
import { ManagedBrowserProviderAdapter, managedBrowserServiceKey } from '../../../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import { SurfaceExecutionRuntime, type SurfaceRuntimeIdentityV1 } from '../../../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import type { BrowserResumeStateStore } from '../../../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Gate = ReturnType<typeof deferred>;
const children: ChildProcess[] = [];
const plans: Array<{ started?: Gate; connect?: Gate; pages?: Gate[] }> = [];
const pendingGates = new Set<Gate>();
const cron = vi.hoisted(() => ({ lookup: vi.fn(), transfer: vi.fn() }));
vi.mock('../../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: cron.lookup }),
}));
vi.mock('../../../../../../src/host/services/surfaceExecution/CronBrowserLoginState', () => ({
  importBrowserStorageStateForOrigin: cron.transfer,
}));
vi.mock('../../../../../../src/host/services/infra/browser/browserLaunchHelpers', async (original) => ({
  ...await original<object>(),
  launchSystemChromeCdpBrowser: async (input: SystemChromeCdpLaunchInput) => {
    const plan = plans.shift() || {};
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    await once(child, 'spawn');
    input.onProcessStart(child);
    child.once('exit', (code, signal) => input.onProcessExit(child, code, signal));
    plan.started?.resolve();
    await plan.connect?.promise;
    return {
      browser: { close: async () => {} } as unknown as Browser,
      context: {
        addInitScript: async () => {}, route: async () => {}, close: async () => {},
        newPage: async () => {
          await plan.pages?.shift()?.promise;
          return { setViewportSize: async () => {}, url: () => 'about:blank', title: async () => 'Example', on: () => {} };
        },
      } as unknown as BrowserContext,
      executable: process.execPath, cdpPort: 0,
    };
  },
}));

function gate() {
  const result = deferred();
  pendingGates.add(result);
  return result;
}

const runs: Array<Promise<unknown>> = [];
function track<T>(promise: Promise<T>): Promise<T> { runs.push(promise); return promise; }

function harness(releaseBrowser?: (serviceKey: string) => Promise<void>) {
  const registry = new RunRegistry();
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const resume: BrowserResumeStateStore = {
    importForConversation: vi.fn(async () => false), exportForConversation: vi.fn(async () => ''),
    clearConversation: vi.fn(async () => {}), activateConversation: vi.fn(),
  };
  const adapter = new ManagedBrowserProviderAdapter(runtime, undefined, releaseBrowser, resume);
  const identity = (suffix: string): SurfaceRuntimeIdentityV1 => {
    const value = { conversationId: `conversation-${suffix}`, runId: `run-${suffix}`, agentId: `agent-${suffix}` };
    registry.start({ runId: value.runId, sessionId: value.conversationId, workspace: process.cwd() });
    const service = browserPool.acquire(managedBrowserServiceKey(value));
    vi.spyOn(service, 'getDomSnapshot').mockImplementation(async () => ({
      snapshotId: `snapshot-${suffix}`, tabId: service.getActiveTab()?.id || 'tab-missing',
      url: 'about:blank', title: 'Example', capturedAtMs: Date.now(), headings: [], interactiveElements: [],
    }));
    return value;
  };
  const execute = (owner: SurfaceRuntimeIdentityV1) => track(adapter.execute({
    identity: owner, operationId: `prepare-${owner.runId}`, action: 'get_dom_snapshot', params: { action: 'get_dom_snapshot' },
    executeProvider: async (_signal, service) => ({ success: true, metadata: { domSnapshot: await service.getDomSnapshot() } }),
  }));
  return { runtime, resume, adapter, identity, execute };
}

function expectProtected(keys: string[]) {
  for (const reason of ['shell-exit-resident', 'residency-idle', 'shutdown'] as const) {
    const result = closeIdleManagedBrowsers(reason);
    expect(result.closed).toBe(0);
    for (const key of keys) expect(result.skipped).toContainEqual({ key, reason: 'in-use' });
  }
  for (const child of children) {
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  }
}

beforeEach(() => {
  vi.stubEnv('CODE_AGENT_BROWSER_PROVIDER', 'system-chrome-cdp');
});

afterEach(async () => {
  for (const value of pendingGates) value.resolve();
  pendingGates.clear();
  await Promise.allSettled(runs.splice(0));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  }
  browserPool.acquire().setLeaseInUse(false);
  await browserPool.acquire().close();
  for (const key of browserPool.listAgents()) await browserPool.releaseAgent(key);
  plans.splice(0);
  cron.lookup.mockReset().mockResolvedValue(undefined);
  cron.transfer.mockReset().mockResolvedValue(true);
});

describe('managed browser setup activity versus production idle cleanup', () => {
  it('protects direct launch before CDP connects, then allows idle cleanup', async () => {
    const started = gate(), connect = gate();
    plans.push({ started, connect });
    const launched = track(browserPool.acquire().launch({ provider: 'system-chrome-cdp' }));
    await started.promise;
    expectProtected(['__default__']);
    connect.resolve(); await launched;
    expect(closeIdleManagedBrowsers('residency-idle').closed).toBe(1);
  });

  it('retains overlapping ensureSession calls until the last settles, including a rejected new tab', async () => {
    const first = gate(), second = gate();
    plans.push({ pages: [first, second] });
    const service = browserPool.acquire();
    await service.launch({ provider: 'system-chrome-cdp' });
    const one = track(service.ensureSession());
    const two = track(service.ensureSession());
    const failure = expect(two).rejects.toThrow('new tab failed');
    await vi.waitFor(() => expect(plans).toHaveLength(0));
    first.resolve(); await one;
    try {
      expectProtected(['__default__']);
    } finally {
      second.reject(new Error('new tab failed')); await failure;
    }
    expect(closeIdleManagedBrowsers('residency-idle').closed).toBe(1);
  });

  it.each(['cron-origin-lookup', 'resume-import'] as const)('protects a launched binding during %s', async (stage) => {
    const h = harness(), owner = h.identity('a');
    const started = gate(), blocked = gate();
    const pause = async () => { started.resolve(); await blocked.promise; return undefined; };
    if (stage === 'cron-origin-lookup') cron.lookup.mockImplementation(pause);
    else vi.mocked(h.resume.importForConversation).mockImplementation(async () => { await pause(); return false; });
    const action = h.execute(owner);
    await started.promise;
    expectProtected([managedBrowserServiceKey(owner)]);
    blocked.resolve(); expect((await action).success).toBe(true);
    // Protection transfers to the real binding lease; setup completion must not clear it.
    expectProtected([managedBrowserServiceKey(owner)]);
    await h.runtime.endRun(owner);
  });

  it('releases preparation activity when initial session setup rejects', async () => {
    const h = harness(), owner = h.identity('failed-session'), page = gate();
    plans.push({ pages: [page] });
    const action = h.execute(owner);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expectProtected([managedBrowserServiceKey(owner)]);
    page.reject(new Error('new tab failed'));
    expect((await action).success).toBe(false);
    expect(closeIdleManagedBrowsers('residency-idle').closed).toBe(1);
  });

  it('releases preparation activity after resume import failure and its cleanup', async () => {
    const h = harness(async () => {}), owner = h.identity('failed-import'), started = gate(), blocked = gate();
    vi.mocked(h.resume.importForConversation).mockImplementation(async () => { started.resolve(); await blocked.promise; throw new Error('restore failed'); });
    const action = h.execute(owner);
    await started.promise;
    expectProtected([managedBrowserServiceKey(owner)]);
    blocked.resolve(); expect((await action).success).toBe(false);
    expect(closeIdleManagedBrowsers('residency-idle').skipped).toContainEqual({
      key: managedBrowserServiceKey(owner), reason: 'no-managed-process',
    });
  });

  it.each([false, true])('protects cron login export with personal already running=%s', async (wasRunning) => {
    const h = harness(), owner = h.identity('cron'), started = gate(), exporting = gate();
    cron.lookup.mockResolvedValue({ origin: { kind: 'cron', metadata: { loginPassThroughOrigin: 'https://example.test' } } });
    if (wasRunning) await browserPool.acquire().ensureSession('about:blank', { provider: 'system-chrome-cdp' });
    // The target launch is followed by the temporary headless personal launch.
    const personalStarted = gate(), personalConnect = gate();
    if (!wasRunning) plans.push({}, { started: personalStarted, connect: personalConnect });
    cron.transfer.mockImplementation(async () => { started.resolve(); await exporting.promise; return true; });
    const action = h.execute(owner);
    if (!wasRunning) {
      await personalStarted.promise;
      expectProtected(['__default__', managedBrowserServiceKey(owner)]);
      personalConnect.resolve();
    }
    await started.promise;
    expectProtected(['__default__', managedBrowserServiceKey(owner)]);
    exporting.resolve(); expect((await action).success).toBe(true);
    const result = closeIdleManagedBrowsers('residency-idle');
    expect(result.closed).toBe(wasRunning ? 1 : 0);
    expect(result.skipped).toContainEqual({ key: managedBrowserServiceKey(owner), reason: 'in-use' });
    await h.runtime.endRun(owner);
  });

  it('keeps the shared personal browser protected until both overlapping cron exports settle', async () => {
    const h = harness(), a = h.identity('cron-a'), b = h.identity('cron-b');
    cron.lookup.mockResolvedValue({ origin: { kind: 'cron', metadata: { loginPassThroughOrigin: 'https://example.test' } } });
    await browserPool.acquire().ensureSession('about:blank', { provider: 'system-chrome-cdp' });
    const startedA = gate(), startedB = gate(), exportA = gate(), exportB = gate();
    cron.transfer.mockImplementationOnce(async () => { startedA.resolve(); await exportA.promise; return true; })
      .mockImplementationOnce(async () => { startedB.resolve(); await exportB.promise; return true; });
    const one = h.execute(a); await startedA.promise;
    const two = h.execute(b); await startedB.promise;
    expectProtected(['__default__', managedBrowserServiceKey(a), managedBrowserServiceKey(b)]);
    exportA.resolve(); expect((await one).success).toBe(true);
    // Task A finishing must not remove B's transient reservation on the same service.
    expectProtected(['__default__', managedBrowserServiceKey(a), managedBrowserServiceKey(b)]);
    exportB.resolve(); expect((await two).success).toBe(true);
    expect(closeIdleManagedBrowsers('residency-idle').closed).toBe(1);
    await h.runtime.endRun(a); await h.runtime.endRun(b);
  });
});
