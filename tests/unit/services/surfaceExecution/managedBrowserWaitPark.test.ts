// N-BROWSER-WAIT-FOR-USER-RESUME-W2 rework: a timed-out wait_for_user parks the window (kept registry), the
// run's cleanup does not close it, and the conversation's next agent run reclaims the same page without navigating.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { ManagedBrowserProviderAdapter } from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import { SurfaceExecutionRuntime, type SurfaceRuntimeIdentityV1 } from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { KeptBrowserRegistry } from '../../../../src/host/services/surfaceExecution/keptBrowserRegistry';
import type { BrowserResumeStateStore } from '../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';
import { browserActionTool } from '../../../../src/host/tools/vision/browserAction';
import type { ToolContext } from '../../../../src/host/tools/types';

const holder = vi.hoisted(() => ({ adapter: null as unknown, runtime: null as unknown, keptRegistry: null as unknown }));
vi.mock('../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter', async (original) => ({
  ...(await original<typeof import('../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter')>()),
  getManagedBrowserProviderAdapter: () => holder.adapter,
}));
vi.mock('../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime', async (original) => ({
  ...(await original<typeof import('../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime')>()),
  getSurfaceExecutionRuntime: () => holder.runtime,
}));
vi.mock('../../../../src/host/services/surfaceExecution/keptBrowserRegistry', async (original) => ({
  ...(await original<typeof import('../../../../src/host/services/surfaceExecution/keptBrowserRegistry')>()),
  getKeptBrowserRegistry: () => holder.keptRegistry,
}));

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
    logger: { log: vi.fn(), getLogsAsString: () => '' },
    beginTrace: vi.fn(() => ({ id: 'trace', targetKind: 'browser', toolName: 'browser_action', action: 'list_tabs', mode: 'headless', startedAtMs: Date.now(), before: null, params: {} })),
    finishTrace: vi.fn((trace: Record<string, unknown>, args: { success: boolean }) => ({ ...trace, success: args.success, completedAtMs: Date.now(), after: null, consoleErrors: [], networkFailures: [] })),
    getPageContent: vi.fn(async () => ({ url: tab.url, title: tab.title, text: 'Invoice portal', links: [] })),
    ensureSession: vi.fn(async () => { running = true; return {}; }),
    isRunning: () => running,
    isProcessAlive: () => running,
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
  let firstKey: string | null | undefined;
  const unused = { ...raw, listTabs: () => [], getActiveTab: () => null };
  const acquire = vi.fn((key: string | null) => {
    firstKey ??= key;
    return (key === firstKey ? raw : unused) as unknown as BrowserService;
  });
  const keptRegistry = new KeptBrowserRegistry({ setKept: poolMocks.setKept, releaseAgent: poolMocks.releaseAgent });
  const resume: BrowserResumeStateStore = {
    exportForConversation: vi.fn(async () => '/x'), importForConversation: vi.fn(async () => false),
    clearConversation: vi.fn(async () => undefined), activateConversation: vi.fn(),
  };
  const adapter = new ManagedBrowserProviderAdapter(runtime, acquire, release, resume, undefined, keptRegistry);
  Object.assign(holder, { adapter, runtime, keptRegistry });
  const idA: SurfaceRuntimeIdentityV1 = { conversationId: 'conversation-p', runId: 'run-a', agentId: 'agent-a' };
  const idB: SurfaceRuntimeIdentityV1 = { conversationId: 'conversation-p', runId: 'run-b', agentId: 'agent-a' };
  const act = (identity: SurfaceRuntimeIdentityV1, id: string, action = 'navigate') => adapter.execute({
    identity, operationId: id, action, params: { action }, async executeProvider() { return { success: true, output: 'ok' }; },
  });
  const startB = () => { registry.startAuxiliary({ runId: 'run-b', sessionId: 'conversation-p', workspace: process.cwd() }); };
  return { startB, runtime, raw, release, acquire, keptRegistry, adapter, idA, idB, act, navigate };
}

afterEach(() => { delete process.env.CODE_AGENT_BROWSER_WAIT_FOR_USER_MS; });

describe('timed-out wait_for_user parks the window', () => {
  it('survives the run end and the next run reclaims it without navigating', async () => {
    process.env.CODE_AGENT_BROWSER_WAIT_FOR_USER_MS = '150';
    const h = harness();
    await h.act(h.idA, 'open');
    const result = await browserActionTool.execute({ action: 'wait_for_user', reason: '请完成页面上的验证' }, {
      ...h.idA, sessionId: 'conversation-p', currentToolCallId: 'tc-park', workingDirectory: process.cwd(),
      requestPermission: vi.fn(async () => true),
    } as unknown as ToolContext);
    expect(result.metadata).toMatchObject({ code: 'WAIT_FOR_USER_TIMEOUT', windowParked: true });
    expect(result.error).toContain('kept on the same page');
    expect(h.keptRegistry.getAlive('conversation-p')).toMatchObject({ parkedForUser: true, url: 'https://portal.example.test/gate' });
    // not offered as a "kept result page" in the chat
    expect(h.keptRegistry.snapshot('conversation-p')).toEqual({ state: 'none', url: null, title: null, reason: null });

    const parkedKey = h.adapter.getBinding(h.idA)!.serviceKey;
    await h.runtime.endRun(h.idA);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.raw.close).not.toHaveBeenCalled();

    // "好了，继续": the next run of the same conversation
    h.acquire.mockClear();
    h.startB();
    const second = await browserActionTool.execute({ action: 'list_tabs' }, {
      ...h.idB, sessionId: 'conversation-p', currentToolCallId: 'tc-resumed', workingDirectory: process.cwd(),
      requestPermission: vi.fn(async () => true),
    } as unknown as ToolContext);
    expect(second.error ?? '').toBe('');
    expect(second.success).toBe(true);
    expect(second.output).toContain('https://portal.example.test/gate');
    expect(h.acquire).toHaveBeenCalledWith(parkedKey);
    expect(h.adapter.getBinding(h.idB)!.serviceKey).toBe(parkedKey);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.keptRegistry.getAlive('conversation-p')).toBeNull();

    // once the reclaiming run ends the window closes normally (no leak)
    await h.runtime.endRun(h.idB);
    expect(h.release).toHaveBeenCalled();
  });

  it('preserves a prior result window while a different window times out and resumes', async () => {
    process.env.CODE_AGENT_BROWSER_WAIT_FOR_USER_MS = '100';
    const h = harness();
    await h.act(h.idA, 'open');
    h.keptRegistry.register({
      conversationId: 'conversation-p', serviceKey: 'prior-result',
      url: 'https://portal.example.test/invoice', title: 'Prior invoice',
      browserService: { onSessionChanged: () => () => undefined },
    });
    poolMocks.releaseAgent.mockClear();
    const result = await browserActionTool.execute({ action: 'wait_for_user', reason: 'Please finish verification' }, {
      ...h.idA, sessionId: 'conversation-p', currentToolCallId: 'tc-two-windows',
      workingDirectory: process.cwd(), requestPermission: vi.fn(async () => true),
    } as unknown as ToolContext);
    expect(result.metadata).toMatchObject({ code: 'WAIT_FOR_USER_TIMEOUT', windowParked: true });
    expect(poolMocks.releaseAgent).not.toHaveBeenCalledWith('prior-result');
    const snapshot = { state: 'kept', url: 'https://portal.example.test/invoice', title: 'Prior invoice', reason: 'keep_result_page' as const };
    expect(h.keptRegistry.snapshot('conversation-p')).toEqual(snapshot);
    const parkedKey = h.adapter.getBinding(h.idA)!.serviceKey;
    await h.runtime.endRun(h.idA);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.keptRegistry.snapshot('conversation-p')).toEqual(snapshot);
    h.startB();
    const resumed = await browserActionTool.execute({ action: 'list_tabs' }, {
      ...h.idB, sessionId: 'conversation-p', currentToolCallId: 'tc-two-resumed',
      workingDirectory: process.cwd(), requestPermission: vi.fn(async () => true),
    } as unknown as ToolContext);
    expect(resumed.success).toBe(true);
    expect(resumed.output).toContain('https://portal.example.test/gate');
    expect(h.adapter.getBinding(h.idB)!.serviceKey).toBe(parkedKey);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.keptRegistry.snapshot('conversation-p')).toEqual(snapshot);
    await h.runtime.endRun(h.idB);
    expect(h.release).toHaveBeenCalledWith(parkedKey);
    expect(poolMocks.releaseAgent).not.toHaveBeenCalledWith('prior-result');
  });

  it('does not promise the window when it could not be parked (no active tab)', async () => {
    process.env.CODE_AGENT_BROWSER_WAIT_FOR_USER_MS = '100';
    const h = harness();
    await h.act(h.idA, 'open');
    h.raw.getActiveTab = () => null;
    const result = await browserActionTool.execute({ action: 'wait_for_user', reason: '请完成验证' }, {
      ...h.idA, sessionId: 'conversation-p', currentToolCallId: 'tc-np', workingDirectory: process.cwd(),
      requestPermission: vi.fn(async () => true),
    } as unknown as ToolContext);
    expect(result.metadata).toMatchObject({ code: 'WAIT_FOR_USER_TIMEOUT', windowParked: false });
    expect(result.error).toContain('may be closed');
    expect(result.error).not.toContain('kept on the same page');
    expect(h.keptRegistry.getAlive('conversation-p')).toBeNull();
  });
});
