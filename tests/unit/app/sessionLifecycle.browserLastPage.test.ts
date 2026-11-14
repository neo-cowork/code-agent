import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../src/host/services/infra/browserService';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { SecureBrowserResumeStateStore } from '../../../src/host/services/surfaceExecution/BrowserResumeStateStore';
import { SecureBrowserLastPageStore } from '../../../src/host/services/surfaceExecution/browserLastPageStore';
import { KeptBrowserRegistry } from '../../../src/host/services/surfaceExecution/keptBrowserRegistry';
import { ManagedBrowserProviderAdapter } from '../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';

const mocks = vi.hoisted(() => ({
  adapter: null as unknown,
  db: {
    getSession: vi.fn(() => ({ id: 'x' })),
    deleteSession: vi.fn(),
    logAuditEvent: vi.fn(),
  },
  sessionManager: {
    restoreSession: vi.fn(async (id: string) => ({ id, messages: [] })),
    createSession: vi.fn(async () => ({ id: 'chat-new', messages: [] })),
    setCurrentSession: vi.fn(),
  },
  taskManager: {
    cleanup: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setSessionContext: vi.fn(),
    getOrCreateCurrentOrchestrator: vi.fn(() => null),
  },
}));

vi.mock('../../../src/host/services/infra/browserPool', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/services/infra/browserPool')>();
  return {
    ...actual,
    browserPool: { setInUse: vi.fn(), setKept: vi.fn(), releaseAgent: vi.fn(async () => undefined) } as unknown as typeof actual.browserPool,
  };
});
vi.mock('../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter')>();
  return { ...actual, getManagedBrowserProviderAdapter: () => mocks.adapter as ManagedBrowserProviderAdapter };
});
vi.mock('../../../src/host/services/surfaceExecution/UserBrowserLinkService', () => ({
  getUserBrowserLinkService: () => ({ end: vi.fn(async () => undefined) }),
}));
vi.mock('../../../src/host/services', () => ({ getSessionManager: () => mocks.sessionManager }));
vi.mock('../../../src/host/services/core', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  getDatabase: () => mocks.db,
}));
vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));
vi.mock('../../../src/host/tools/utils/toolScreenshotDir', () => ({ removeToolScreenshotDir: vi.fn(async () => undefined) }));

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (k: string) => values.get(k) ?? null,
    setItem: async (k: string, v: string) => void values.set(k, v),
    removeItem: async (k: string) => void values.delete(k),
  };
}

function fakeWindow() {
  let running = false;
  const tab = { id: 'tab-1', url: 'about:blank', title: 'Fixture' };
  const service = {
    ensureSession: vi.fn(async (url = 'about:blank') => { if (!running) { running = true; tab.url = url; } return {}; }),
    isRunning: () => running,
    getActiveTab: () => (running ? { ...tab } : null),
    listTabs: () => (running ? [{ ...tab }] : []),
    navigate: vi.fn(async (url: string) => { tab.url = url; }),
    exportStorageState: vi.fn(async (filePath: string) => {
      await fs.promises.writeFile(filePath, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
    }),
    importStorageState: vi.fn(async () => undefined),
    getSessionState: () => ({
      sessionId: 's', profileId: 'p', provider: 'system-chrome-cdp', running,
      tabCount: running ? 1 : 0, lease: null, activeTab: running ? { ...tab } : null,
    }),
    onSessionChanged: () => () => undefined,
    getDomSnapshot: vi.fn(async () => ({
      snapshotId: 'snap', tabId: tab.id, capturedAtMs: 0, url: tab.url, title: tab.title, headings: [], interactiveElements: [],
    })),
    close: vi.fn(async () => { running = false; }),
    setLeaseInUse: vi.fn(),
  };
  return { service: service as unknown as BrowserService, raw: service };
}

describe('switching vs deleting a chat: managed browser last page', () => {
  let tempRoot = '';
  let registry: RunRegistry;
  let runtime: SurfaceExecutionRuntime;
  let adapter: ManagedBrowserProviderAdapter;
  let resumeStore: SecureBrowserResumeStateStore;
  let resumeStorage: ReturnType<typeof memoryStorage>;
  let lastPageStore: SecureBrowserLastPageStore;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let windows: Map<string, ReturnType<typeof fakeWindow>>;
  let current: string | null;
  let runN = 0;

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-last-page-'));
    resumeStorage = memoryStorage();
    resumeStore = new SecureBrowserResumeStateStore({ rootDir: tempRoot, secureStorage: resumeStorage, workspaceRoot: process.cwd() });
    lastPageStore = new SecureBrowserLastPageStore({ secureStorage: memoryStorage() });
    registry = new RunRegistry();
    runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    windows = new Map();
    adapter = new ManagedBrowserProviderAdapter(
      runtime,
      (key) => {
        const k = key ?? 'personal';
        if (!windows.has(k)) windows.set(k, fakeWindow());
        return windows.get(k)!.service;
      },
      async (key) => { await windows.get(key)?.raw.close(); },
      resumeStore,
      logger,
      new KeptBrowserRegistry({ setKept: vi.fn(), releaseAgent: vi.fn(async () => undefined) }),
      lastPageStore,
    );
    mocks.adapter = adapter;
    current = null;
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function lifecycle() {
    const { SessionLifecycleAppService } = await import('../../../src/host/app/sessionLifecycleAppService');
    return new SessionLifecycleAppService({
      getTaskManager: () => mocks.taskManager as never,
      getConfigService: () => ({}) as never,
      getCurrentSessionId: () => current,
      setCurrentSessionId: (id) => { current = id; },
      getWorkingDirectory: () => undefined,
    });
  }

  const startRun = (conversationId: string): SurfaceRuntimeIdentityV1 => {
    const runId = `run-${++runN}`;
    registry.startAuxiliary({ runId, sessionId: conversationId, workspace: process.cwd() });
    return { conversationId, runId, agentId: 'agent-main' };
  };
  const navigate = (identity: SurfaceRuntimeIdentityV1, url: string) => adapter.execute({
    identity, operationId: `nav-${++runN}`, action: 'navigate', params: { action: 'navigate', url },
    async executeProvider(_s, svc) { await svc.navigate(url); return { success: true, output: url }; },
  });
  const observe = (identity: SurfaceRuntimeIdentityV1) => adapter.execute({
    identity, operationId: `obs-${++runN}`, action: 'get_dom_snapshot', params: { action: 'get_dom_snapshot' },
    async executeProvider(_s, svc) {
      const domSnapshot = await svc.getDomSnapshot();
      return { success: true, output: `URL: ${domSnapshot.url}`, metadata: { domSnapshot } };
    },
  });
  const seedLogin = async (conversationId: string, identity: SurfaceRuntimeIdentityV1) => {
    const key = adapter.getBinding(identity)!.serviceKey;
    await resumeStore.exportForConversation(conversationId, windows.get(key)!.service);
  };

  it('loadSession away keeps the address, drops login state, and re-activation works', async () => {
    const svc = await lifecycle();
    current = 'chat-a';
    mocks.adapter = adapter;
    const turn1 = startRun('chat-a');
    await navigate(turn1, 'https://host/pricing?plan=pro#annual');
    await seedLogin('chat-a', turn1);
    await runtime.endRun(turn1);
    expect(resumeStorage.values.size).toBe(1); // login state saved
    expect(await lastPageStore.getForConversation('chat-a')).toBe('https://host/pricing');

    await svc.loadSession('chat-b'); // leaves chat-a
    expect(resumeStorage.values.size).toBe(0);
    expect(await lastPageStore.getForConversation('chat-a')).toBe('https://host/pricing');

    await svc.loadSession('chat-a'); // back
    const turn2 = startRun('chat-a');
    const observed = await observe(turn2);
    expect(observed.output).toBe('URL: https://host/pricing');
    const win2 = windows.get(adapter.getBinding(turn2)!.serviceKey)!;
    expect(win2.raw.importStorageState).not.toHaveBeenCalled(); // login state was dropped
    expect(logger.info).toHaveBeenCalledWith('Restored managed browser last page', expect.objectContaining({ reason: 'last_page_restored', url: 'https://host/pricing' }));
    await runtime.endRun(turn2);
  });

  it('createSession away keeps the address, and a window released after the switch still records', async () => {
    const svc = await lifecycle();
    current = 'chat-a';
    const inflight = startRun('chat-a');
    await navigate(inflight, 'https://host/docs/intro?x=1');

    await svc.createSession(); // leaves chat-a while its window is still open
    await runtime.endRun(inflight); // released after the switch
    expect(await lastPageStore.getForConversation('chat-a')).toBe('https://host/docs/intro');
  });

  it('SessionManager.deleteSession drops the address and the late release does not write it back', async () => {
    const { getSessionManager } = await import('../../../src/host/services/infra/sessionManager');
    const turn1 = startRun('chat-a');
    await navigate(turn1, 'https://host/pricing?plan=pro');
    await runtime.endRun(turn1);
    expect(await lastPageStore.getForConversation('chat-a')).toBe('https://host/pricing');

    await getSessionManager().deleteSession('chat-a');
    expect(mocks.db.deleteSession).toHaveBeenCalledWith('chat-a');
    expect(await lastPageStore.getForConversation('chat-a')).toBeNull();

    const turn2 = startRun('chat-a');
    const observed = await observe(turn2);
    expect(observed.output).toBe('URL: about:blank');
    await runtime.endRun(turn2);
    expect(await lastPageStore.getForConversation('chat-a')).toBeNull();
  });
});
