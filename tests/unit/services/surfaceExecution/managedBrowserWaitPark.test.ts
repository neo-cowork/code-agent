// N-BROWSER-WAIT-FOR-USER-RESUME-W2 rework: a timed-out wait_for_user parks the window (kept registry), the
// run's cleanup does not close it, and the conversation's next agent run reclaims the same page without navigating.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { ManagedBrowserProviderAdapter } from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import { SurfaceExecutionRuntime, type SurfaceRuntimeIdentityV1 } from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { KeptBrowserRegistry } from '../../../../src/host/services/surfaceExecution/keptBrowserRegistry';
import type { BrowserResumeStateStore } from '../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';
import { executeWaitForUser } from '../../../../src/host/tools/vision/browserWaitForUser';
import { BROWSER_WAIT_FOR_USER } from '../../../../src/shared/constants/timeouts';

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async () => undefined }),
}));
const poolMocks = vi.hoisted(() => ({ setInUse: vi.fn(), setKept: vi.fn(), releaseAgent: vi.fn(async () => undefined) }));
vi.mock('../../../../src/host/services/infra/browserPool', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/host/services/infra/browserPool')>();
  return { ...actual, browserPool: poolMocks as unknown as typeof actual.browserPool };
});

function harness() {
  const registry = new RunRegistry();
  registry.start({ runId: 'run-a', sessionId: 'conversation-p', workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  let running = false;
  const tab = { id: 'tab-1', url: 'https://portal.example.test/gate', title: 'Gate' };
  const navigate = vi.fn(async (url: string) => { tab.url = url; });
  const raw = {
    ensureSession: vi.fn(async () => { running = true; return {}; }),
    isRunning: () => running,
    getActiveTab: () => (running ? { ...tab } : null),
    listTabs: () => [{ ...tab }],
    navigate,
    getSessionState: () => ({ sessionId: 's', profileId: 'p', provider: 'system-chrome-cdp', running, tabCount: 1, lease: null, activeTab: { ...tab } }),
    onSessionChanged: () => () => undefined,
    getDomSnapshot: vi.fn(async () => ({ snapshotId: 'snap', tabId: 'tab-1', capturedAtMs: Date.now(), url: tab.url, title: tab.title, headings: [], interactiveElements: [] })),
    close: vi.fn(async () => { running = false; }),
    setLeaseInUse: vi.fn(),
  };
  const release = vi.fn(async () => raw.close());
  const acquire = vi.fn((_key: string | null) => raw as unknown as BrowserService);
  const keptRegistry = new KeptBrowserRegistry({ setKept: poolMocks.setKept, releaseAgent: poolMocks.releaseAgent });
  const resume: BrowserResumeStateStore = {
    exportForConversation: vi.fn(async () => '/x'), importForConversation: vi.fn(async () => false),
    clearConversation: vi.fn(async () => undefined), activateConversation: vi.fn(),
  };
  const adapter = new ManagedBrowserProviderAdapter(runtime, acquire, release, resume, undefined, keptRegistry);
  const idA: SurfaceRuntimeIdentityV1 = { conversationId: 'conversation-p', runId: 'run-a', agentId: 'agent-a' };
  const idB: SurfaceRuntimeIdentityV1 = { conversationId: 'conversation-p', runId: 'run-b', agentId: 'agent-a' };
  const act = (identity: SurfaceRuntimeIdentityV1, id: string, action = 'navigate') => adapter.execute({
    identity, operationId: id, action, params: { action }, async executeProvider() { return { success: true, output: 'ok' }; },
  });
  const startB = () => { registry.startAuxiliary({ runId: 'run-b', sessionId: 'conversation-p', workspace: process.cwd() }); };
  return { startB, runtime, raw, release, acquire, keptRegistry, adapter, idA, idB, act, navigate };
}

afterEach(() => { delete process.env[BROWSER_WAIT_FOR_USER.LIMIT_ENV]; });

describe('timed-out wait_for_user parks the window', () => {
  it('survives the run end and the next run reclaims it without navigating', async () => {
    process.env[BROWSER_WAIT_FOR_USER.LIMIT_ENV] = '150';
    const h = harness();
    await h.act(h.idA, 'open');
    const result = await executeWaitForUser({
      identity: h.idA,
      context: { sessionId: 'conversation-p', currentToolCallId: 'tc-park' },
      params: { reason: '请完成页面上的验证' },
      adapter: h.adapter,
      runtime: h.runtime,
      keptRegistry: h.keptRegistry,
    });
    expect(result.metadata).toMatchObject({ code: 'WAIT_FOR_USER_TIMEOUT', windowParked: true });
    expect(result.error).toContain('kept on the same page');
    expect(h.keptRegistry.getAlive('conversation-p')).toMatchObject({ parkedForUser: true, url: 'https://portal.example.test/gate' });
    // not offered as a "kept result page" in the chat
    expect(h.keptRegistry.snapshot('conversation-p')).toEqual({ state: 'none', url: null, title: null });

    const parkedKey = h.adapter.getBinding(h.idA)!.serviceKey;
    await h.runtime.endRun(h.idA);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.raw.close).not.toHaveBeenCalled();

    // "好了，继续": the next run of the same conversation
    h.acquire.mockClear();
    h.startB();
    const second = await h.act(h.idB, 'resume-1'); expect(second.error ?? '').toBe(''); expect(second.success).toBe(true);
    expect(h.acquire).toHaveBeenCalledWith(parkedKey);
    expect(h.adapter.getBinding(h.idB)!.serviceKey).toBe(parkedKey);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.keptRegistry.getAlive('conversation-p')).toBeNull();

    // once the reclaiming run ends the window closes normally (no leak)
    await h.runtime.endRun(h.idB);
    expect(h.release).toHaveBeenCalled();
  });

  it('does not promise the window when it could not be parked (no active tab)', async () => {
    process.env[BROWSER_WAIT_FOR_USER.LIMIT_ENV] = '100';
    const h = harness();
    await h.act(h.idA, 'open');
    h.raw.getActiveTab = () => null;
    const result = await executeWaitForUser({
      identity: h.idA, context: { sessionId: 'conversation-p', currentToolCallId: 'tc-np' }, params: { reason: '请完成验证' },
      adapter: h.adapter, runtime: h.runtime, keptRegistry: h.keptRegistry,
    });
    expect(result.metadata).toMatchObject({ code: 'WAIT_FOR_USER_TIMEOUT', windowParked: false });
    expect(result.error).toContain('may be closed');
    expect(result.error).not.toContain('kept on the same page');
    expect(h.keptRegistry.getAlive('conversation-p')).toBeNull();
  });
});
