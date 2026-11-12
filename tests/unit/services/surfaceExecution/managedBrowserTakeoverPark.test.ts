// N-FIX-FIX-BROWSER-SECRETREF-HARDEN（FB-578）：secretRef 接管后「停靠，再认领」
// 的 adapter 级链路（fake BrowserService + 真 SurfaceExecutionRuntime + 真 registry）。
// run 在 waiting_human 中结束 → 窗口停靠（kept, reason='takeover'，不释放不关窗，
// 会话照常终结）→ 晚到 Continue 不能 resume → 同会话下一段 agent run 认领同一
// serviceKey（首个动作结果带 get_dom_snapshot 提示，一次性）→ 回收（close 事件）
// 后翻 closed、不再被认领 → resume 过的接管不停靠。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { ManagedBrowserProviderAdapter } from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import {
  KeptBrowserRegistry,
  type KeptBrowserPoolFacade,
} from '../../../../src/host/services/surfaceExecution/keptBrowserRegistry';
import type { BrowserResumeStateStore } from '../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';
import { typeSecret } from '../../../../src/host/tools/vision/browserSecretRefGuard';

const SECRET = 'park-secret-Zq9!fixture';
const NAME = 'CODE_AGENT_BROWSER_SECRET_TAKEOVER_PARK_PWD';
const ORIGINS = `${NAME}_ORIGINS`;

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async () => undefined }),
}));

// adapter 的 releaseBinding 走 browserPool.setInUse 单例：换成可断言的假池。
const poolMocks = vi.hoisted(() => ({
  setInUse: vi.fn(),
  setKept: vi.fn(),
  releaseAgent: vi.fn(async () => undefined),
}));
vi.mock('../../../../src/host/services/infra/browserPool', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/host/services/infra/browserPool')>();
  return {
    ...actual,
    browserPool: poolMocks as unknown as typeof actual.browserPool,
  };
});

function createFakeBrowser(getUrl: () => string) {
  let running = false;
  let snapshot = 0;
  const listeners = new Set<(reason: string) => void>();
  const typed = vi.fn(async () => undefined);
  const close = vi.fn(async () => { running = false; });
  const service = {
    ensureSession: vi.fn(async () => { running = true; return {}; }),
    isRunning: () => running,
    getActiveTab: () => (running ? { id: 'tab-1', url: getUrl(), title: 'T' } : null),
    getLiveTabUrl: () => getUrl(),
    getSessionState: () => ({
      sessionId: 'park-session',
      profileId: 'isolated-profile',
      provider: 'system-chrome-cdp',
      running,
      tabCount: running ? 1 : 0,
      lease: running
        ? { leaseId: 'l', owner: 'managed-browser', acquiredAtMs: 1, lastHeartbeatAtMs: 1, expiresAtMs: Number.MAX_SAFE_INTEGER, ttlMs: 1800000, status: 'active' as const }
        : null,
      activeTab: running ? { id: 'tab-1', url: getUrl(), title: 'T', canGoBack: false, canGoForward: false } : null,
    }),
    onSessionChanged: (listener: (reason: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitSessionChangedForTest: (reason: string) => {
      for (const listener of listeners) listener(reason);
    },
    getDomSnapshot: vi.fn(async () => {
      snapshot += 1;
      return {
        snapshotId: `snapshot-${snapshot}`,
        tabId: 'tab-1',
        capturedAtMs: Date.now(),
        url: getUrl(),
        title: 'T',
        headings: [],
        interactiveElements: [],
      };
    }),
    getElementBoundingBox: vi.fn(async () => ({ x: 1, y: 2, width: 3, height: 4 })),
    type: typed,
    typeTargetRef: typed,
    exportStorageState: vi.fn(async () => ({ path: '/x', accountState: {} })),
    close,
    setLeaseInUse: vi.fn(),
  };
  return { service: service as unknown as BrowserService, raw: service, close, typed };
}

function createKeptPool(): KeptBrowserPoolFacade {
  return {
    setKept: poolMocks.setKept,
    releaseAgent: poolMocks.releaseAgent,
  };
}

function setup(url: string) {
  const registry = new RunRegistry();
  registry.start({ runId: 'run-a', sessionId: 'conversation-a', workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const identity: SurfaceRuntimeIdentityV1 = {
    conversationId: 'conversation-a',
    runId: 'run-a',
    agentId: 'agent-a',
  };
  const fake = createFakeBrowser(() => url);
  const release = vi.fn(async () => fake.raw.close());
  const acquire = vi.fn((_serviceKey: string | null) => fake.service);
  const resumeStore: BrowserResumeStateStore = {
    exportForConversation: vi.fn(async () => '/x'),
    importForConversation: vi.fn(async () => false),
    clearConversation: vi.fn(async () => undefined),
    activateConversation: vi.fn(),
  };
  const keptRegistry = new KeptBrowserRegistry(createKeptPool());
  const adapter = new ManagedBrowserProviderAdapter(runtime, acquire, release, resumeStore, undefined, keptRegistry);
  const run = (
    who: SurfaceRuntimeIdentityV1,
    action: string,
    operationId: string,
    executeProvider: (b: BrowserService) => Promise<any>,
  ) =>
    adapter.execute({
      identity: who,
      operationId,
      action,
      params: { action },
      executeProvider: (_signal, b) => executeProvider(b),
    });
  const ids = { sessionId: '' };
  const prep = async () => {
    const r = await run(identity, 'get_dom_snapshot', 'prep', async (b) => ({ success: true, metadata: { domSnapshot: await b.getDomSnapshot() } }));
    ids.sessionId = (r.metadata as any).surfaceExecutionSessionV1.sessionId;
    return r;
  };
  const mismatch = () =>
    run(identity, 'type', 'type-1', (b) => typeSecret({ browserService: b as never, secretRef: `env:${NAME}`, selector: '#pw' }));
  const subject = () => ({ sessionId: ids.sessionId, runId: identity.runId, agentId: identity.agentId });
  return { registry, runtime, identity, fake, acquire, release, adapter, keptRegistry, run, prep, mismatch, subject, ids };
}

/** 触发一次 mismatch 停靠前提（会话 waiting_human），返回 run-a 的 serviceKey。 */
async function parkSetup(url = 'https://idp.other.test/login') {
  const h = setup(url);
  await h.prep();
  const result = await h.mismatch();
  expect(result.metadata?.code).toBe('SECRET_REF_ORIGIN_MISMATCH');
  expect((result.metadata as any).surfaceExecutionSessionV1.state).toBe('waiting_human');
  const binding = h.adapter.getBinding(h.identity);
  return { ...h, runOneServiceKey: binding?.serviceKey ?? '' };
}

describe('managed browser takeover park (N-FIX-FIX-BROWSER-SECRETREF-HARDEN)', () => {
  beforeEach(() => {
    process.env[NAME] = SECRET;
    process.env[ORIGINS] = 'https://app.example.test';
    poolMocks.setInUse.mockClear();
    poolMocks.setKept.mockClear();
    poolMocks.releaseAgent.mockClear();
  });
  afterEach(() => {
    delete process.env[NAME];
    delete process.env[ORIGINS];
  });

  it('parks the window when the run ends while waiting_human: no release, no close, session still ends', async () => {
    const h = await parkSetup();
    await h.runtime.endRun(h.identity);

    // The Surface session itself still ends: a late Continue must not resume it.
    await expect(h.runtime.control(h.subject(), 'resume')).rejects.toThrow(/Cannot resume a Surface session while completed/);
    // The window is parked instead of released/closed.
    expect(h.release).not.toHaveBeenCalled();
    expect(h.fake.close).not.toHaveBeenCalled();
    expect(h.fake.raw.setLeaseInUse).toHaveBeenLastCalledWith(false);
    expect(h.keptRegistry.get('conversation-a')).toMatchObject({
      state: 'kept',
      reason: 'takeover',
      serviceKey: h.runOneServiceKey,
      url: 'https://idp.other.test/login',
    });
    expect(poolMocks.setKept).toHaveBeenCalledWith(h.runOneServiceKey, true);
  });

  it('next run in the same conversation claims the parked window: same service key, one-shot re-observe note, entry consumed', async () => {
    const h = await parkSetup();
    await h.runtime.endRun(h.identity);

    h.registry.unregister('run-a');
    h.registry.start({ runId: 'run-b', sessionId: 'conversation-a', workspace: process.cwd() });
    const second: SurfaceRuntimeIdentityV1 = {
      conversationId: 'conversation-a',
      runId: 'run-b',
      agentId: 'agent-a',
    };
    h.acquire.mockClear();
    const first = await h.run(second, 'navigate', 'nav-1', async () => ({ success: true, output: 'nav ok' }));
    expect(first.success).toBe(true);
    // Same physical window: the claim acquired the parked service key.
    expect(h.acquire).toHaveBeenCalledWith(h.runOneServiceKey);
    expect(h.adapter.getBinding(second)?.serviceKey).toBe(h.runOneServiceKey);
    // First action after the claim carries the one-sentence re-observe instruction.
    expect(first.output).toContain('get_dom_snapshot before acting');
    expect(first.output).toContain('takeover invalidates earlier observations');
    // One-shot: the second action is clean.
    const secondResult = await h.run(second, 'navigate', 'nav-2', async () => ({ success: true, output: 'nav ok 2' }));
    expect(secondResult.output).not.toContain('get_dom_snapshot');
    // The park entry is consumed by the claim.
    expect(h.keptRegistry.getAlive('conversation-a')).toBeNull();
    // And the claiming run releases normally at its end (no lingering park).
    h.acquire.mockClear();
    await h.runtime.endRun(second);
    expect(h.release).toHaveBeenCalledWith(h.runOneServiceKey);
    expect(h.keptRegistry.get('conversation-a')).toBeNull();
  });

  it('a reclaimed (closed) park is not claimable: plain closed state, fresh window for the next run', async () => {
    const h = await parkSetup();
    await h.runtime.endRun(h.identity);
    // Idle reclaim / user close: the window's own close event flips the entry.
    h.fake.raw.emitSessionChangedForTest('close');
    expect(h.keptRegistry.snapshot('conversation-a')).toMatchObject({
      state: 'closed',
      reason: 'takeover',
    });
    expect(h.keptRegistry.getAlive('conversation-a')).toBeNull();

    h.registry.unregister('run-a');
    h.registry.start({ runId: 'run-b', sessionId: 'conversation-a', workspace: process.cwd() });
    const second: SurfaceRuntimeIdentityV1 = {
      conversationId: 'conversation-a',
      runId: 'run-b',
      agentId: 'agent-a',
    };
    const result = await h.run(second, 'navigate', 'nav-1', async () => ({ success: true, output: 'fresh ok' }));
    expect(result.success).toBe(true);
    // Fresh isolated window: new run-scoped service key, no handoff note.
    expect(h.adapter.getBinding(second)?.serviceKey).not.toBe(h.runOneServiceKey);
    expect(result.output).not.toContain('get_dom_snapshot');
    expect(h.keptRegistry.get('conversation-a')).toMatchObject({ state: 'closed' });
  });

  it('a takeover the user resumed does not park: the run ends and releases as before', async () => {
    const h = await parkSetup();
    await h.runtime.control(h.subject(), 'resume');
    const next = await h.run(h.identity, 'navigate', 'nav-1', async () => ({ success: true, output: 'ok' }));
    expect(next.success).toBe(true);
    await h.runtime.endRun(h.identity);

    expect(h.release).toHaveBeenCalledWith(h.runOneServiceKey);
    expect(h.keptRegistry.get('conversation-a')).toBeNull();
  });

  it('the secret value appears in no result text through the park and claim flow', async () => {
    const h = await parkSetup();
    await h.runtime.endRun(h.identity);
    h.registry.unregister('run-a');
    h.registry.start({ runId: 'run-b', sessionId: 'conversation-a', workspace: process.cwd() });
    const second: SurfaceRuntimeIdentityV1 = {
      conversationId: 'conversation-a',
      runId: 'run-b',
      agentId: 'agent-a',
    };
    const first = await h.run(second, 'navigate', 'nav-1', async () => ({ success: true, output: 'nav ok' }));
    const mismatchResult = await h.run(second, 'type', 'type-2', (b) => typeSecret({ browserService: b as never, secretRef: `env:${NAME}`, selector: '#pw' }));
    expect(JSON.stringify([first, mismatchResult])).not.toContain(SECRET);
  });
});
