import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { SecureBrowserResumeStateStore } from '../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';
import { SecureBrowserLastPageStore } from '../../../../src/host/services/surfaceExecution/browserLastPageStore';
import { KeptBrowserRegistry } from '../../../../src/host/services/surfaceExecution/keptBrowserRegistry';
import {
  MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY,
  ManagedBrowserProviderAdapter,
} from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../../src/shared/contract/surfaceExecution';

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async () => undefined }),
}));

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

function createMemorySecureStorage() {
  const values = new Map<string, string>();
  return {
    values,
    async getItem(key: string) {
      return values.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      values.set(key, value);
    },
    async removeItem(key: string) {
      values.delete(key);
    },
  };
}

function createFakeWindow(initialUrl = 'about:blank') {
  let running = false;
  let snapshotSeq = 0;
  const tab = { id: 'tab-1', url: initialUrl, title: 'Fixture' };
  const callOrder: string[] = [];
  const navigate = vi.fn(async (url: string) => {
    callOrder.push(`navigate:${url}`);
    tab.url = url;
  });
  const service = {
    ensureSession: vi.fn(async (url = 'about:blank') => {
      callOrder.push(`ensureSession:${url}`);
      if (!running) {
        running = true;
        tab.url = url;
      }
      return {};
    }),
    isRunning: () => running,
    getActiveTab: () => (running ? { ...tab } : null),
    listTabs: () => (running ? [{ ...tab }] : []),
    navigate,
    exportStorageState: vi.fn(async (filePath: string) => {
      await fs.promises.writeFile(filePath, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
    }),
    importStorageState: vi.fn(async () => {
      callOrder.push('importStorageState');
    }),
    getSessionState: () => ({
      sessionId: 'session-1',
      profileId: 'profile-1',
      provider: 'system-chrome-cdp',
      running,
      tabCount: running ? 1 : 0,
      lease: null,
      activeTab: running ? { ...tab } : null,
    }),
    onSessionChanged: () => () => undefined,
    getDomSnapshot: vi.fn(async () => {
      snapshotSeq += 1;
      return {
        snapshotId: `snap-${snapshotSeq}`,
        tabId: tab.id,
        capturedAtMs: Date.now(),
        url: tab.url,
        title: tab.title,
        headings: [],
        interactiveElements: [],
      };
    }),
    close: vi.fn(async () => {
      running = false;
    }),
    setLeaseInUse: vi.fn(),
  };
  return {
    tab,
    callOrder,
    navigate,
    service: service as unknown as BrowserService,
    raw: service,
  };
}

function createHarness() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `browser-last-page-${randomUUID()}-`));
  const resumeSecureStorage = createMemorySecureStorage();
  const lastPageSecureStorage = createMemorySecureStorage();
  const resumeStateStore = new SecureBrowserResumeStateStore({
    rootDir: tempRoot,
    secureStorage: resumeSecureStorage,
    workspaceRoot: process.cwd(),
  });
  const lastPageStore = new SecureBrowserLastPageStore({
    secureStorage: lastPageSecureStorage,
  });
  const registry = new RunRegistry();
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const keptRegistry = new KeptBrowserRegistry({
    setKept: poolMocks.setKept,
    releaseAgent: poolMocks.releaseAgent,
  });
  const windows = new Map<string, ReturnType<typeof createFakeWindow>>();
  const personalWindow = createFakeWindow('about:blank');
  const acquire = vi.fn((serviceKey: string | null) => {
    if (serviceKey === null || serviceKey === MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY) {
      return personalWindow.service;
    }
    let win = windows.get(serviceKey);
    if (!win) {
      win = createFakeWindow('about:blank');
      windows.set(serviceKey, win);
    }
    return win.service;
  });
  const release = vi.fn(async (serviceKey: string) => {
    const win = serviceKey === MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY
      ? personalWindow
      : windows.get(serviceKey);
    await win?.raw.close();
  });
  const resumeLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const adapter = new ManagedBrowserProviderAdapter(
    runtime,
    acquire,
    release,
    resumeStateStore,
    resumeLogger,
    keptRegistry,
    lastPageStore,
  );

  let runCounter = 0;
  const startAgentRun = (conversationId = 'conversation-1', runId = `run-${++runCounter}`): SurfaceRuntimeIdentityV1 => {
    registry.startAuxiliary({ runId, sessionId: conversationId, workspace: process.cwd() });
    return { conversationId, runId, agentId: 'agent-main' };
  };
  const startUserRun = (conversationId = 'conversation-1', runId = `user-run-${++runCounter}`): SurfaceRuntimeIdentityV1 => {
    registry.startAuxiliary({ runId, sessionId: conversationId, workspace: process.cwd() });
    return { conversationId, runId, agentId: SURFACE_USER_BROWSER_AGENT_ID };
  };

  const navigateInRun = (identity: SurfaceRuntimeIdentityV1, url: string) => adapter.execute({
    identity,
    operationId: `nav-${randomUUID()}`,
    action: 'navigate',
    params: { action: 'navigate', url },
    async executeProvider(_signal, browserService) {
      await browserService.navigate(url);
      return { success: true, output: `Navigated to ${url}` };
    },
  });

  const observeInRun = (identity: SurfaceRuntimeIdentityV1) => adapter.execute({
    identity,
    operationId: `obs-${randomUUID()}`,
    action: 'get_dom_snapshot',
    params: { action: 'get_dom_snapshot' },
    async executeProvider(_signal, browserService) {
      const domSnapshot = await browserService.getDomSnapshot();
      return { success: true, output: `URL: ${domSnapshot.url}`, metadata: { domSnapshot } };
    },
  });

  const cleanup = () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  };

  return {
    adapter,
    runtime,
    keptRegistry,
    resumeStateStore,
    lastPageStore,
    lastPageSecureStorage,
    resumeLogger,
    windows,
    personalWindow,
    acquire,
    release,
    startAgentRun,
    startUserRun,
    navigateInRun,
    observeInRun,
    cleanup,
  };
}

describe('managed browser cross-turn last page restore', () => {
  it('stores origin+pathname only when turn 1 ends on https://host/a/b?q=1#h', async () => {
    const h = createHarness();
    try {
      const turn1 = h.startAgentRun('conversation-1', 'run-1');
      const navResult = await h.navigateInRun(turn1, 'https://host/a/b?q=1#h');
      expect(navResult.success).toBe(true);

      await h.runtime.endRun(turn1);
      expect(h.release).toHaveBeenCalledTimes(1);

      const expectedSlot = `browser-last-page:${createHash('sha256').update('conversation-1').digest('hex')}`;
      expect([...h.lastPageSecureStorage.values.entries()]).toEqual([
        [expectedSlot, 'https://host/a/b'],
      ]);
      expect(await h.lastPageStore.getForConversation('conversation-1')).toBe('https://host/a/b');

      // Credentials in URL are also stripped to origin+pathname.
      const turnCreds = h.startAgentRun('conversation-creds', 'run-creds');
      await h.navigateInRun(turnCreds, 'https://user:secret@host:8443/a/b?q=1#h');
      await h.runtime.endRun(turnCreds);
      expect(await h.lastPageStore.getForConversation('conversation-creds')).toBe('https://host:8443/a/b');
    } finally {
      h.cleanup();
    }
  });

  it('reopens turn 2 fresh window on the previous turn last page after storage-state import', async () => {
    const h = createHarness();
    try {
      const turn1 = h.startAgentRun('conversation-1', 'run-1');
      await h.navigateInRun(turn1, 'https://host/a/b?q=1#h');
      const turn1Key = h.adapter.getBinding(turn1)!.serviceKey;
      // Seed conversation login state so importStorageState also runs in ensureBinding.
      await h.resumeStateStore.exportForConversation('conversation-1', h.windows.get(turn1Key)!.service);
      await h.runtime.endRun(turn1);

      const turn2 = h.startAgentRun('conversation-1', 'run-2');
      const observed = await h.observeInRun(turn2);
      const turn2Key = h.adapter.getBinding(turn2)!.serviceKey;
      expect(turn2Key).not.toBe(turn1Key);

      const turn2Window = h.windows.get(turn2Key)!;
      expect(observed.success).toBe(true);
      expect(observed.output).toBe('URL: https://host/a/b');
      expect(turn2Window.navigate).toHaveBeenCalledTimes(1);
      expect(turn2Window.navigate).toHaveBeenCalledWith('https://host/a/b');
      expect(turn2Window.callOrder).toEqual([
        'ensureSession:about:blank',
        'importStorageState',
        'navigate:https://host/a/b',
      ]);
      expect(h.resumeLogger.info).toHaveBeenCalledWith(
        'Restored managed browser last page',
        expect.objectContaining({
          reason: 'last_page_restored',
          url: 'https://host/a/b',
        }),
      );
      await h.runtime.endRun(turn2);
    } finally {
      h.cleanup();
    }
  });

  it('does not store or restore about:blank', async () => {
    const h = createHarness();
    try {
      const turn1 = h.startAgentRun('conversation-blank', 'run-1');
      await h.observeInRun(turn1);
      await h.runtime.endRun(turn1);

      expect(h.lastPageSecureStorage.values.size).toBe(0);

      const turn2 = h.startAgentRun('conversation-blank', 'run-2');
      const observed = await h.observeInRun(turn2);
      const turn2Key = h.adapter.getBinding(turn2)!.serviceKey;
      expect(observed.output).toBe('URL: about:blank');
      expect(h.windows.get(turn2Key)!.navigate).not.toHaveBeenCalled();
      await h.runtime.endRun(turn2);
    } finally {
      h.cleanup();
    }
  });

  it('does not store or restore file: or chrome: schemes', async () => {
    const h = createHarness();
    try {
      for (const nonHttpUrl of ['file:///tmp/local-fixture.html', 'chrome://settings']) {
        const turn1 = h.startAgentRun('conversation-scheme');
        await h.navigateInRun(turn1, nonHttpUrl);
        await h.runtime.endRun(turn1);

        expect(h.lastPageSecureStorage.values.size).toBe(0);

        const turn2 = h.startAgentRun('conversation-scheme');
        const observed = await h.observeInRun(turn2);
        const turn2Key = h.adapter.getBinding(turn2)!.serviceKey;
        expect(observed.output).toBe('URL: about:blank');
        expect(h.windows.get(turn2Key)!.navigate).not.toHaveBeenCalled();
        await h.runtime.endRun(turn2);
      }
    } finally {
      h.cleanup();
    }
  });

  it('does not store or restore a path with a token-like segment', async () => {
    const h = createHarness();
    try {
      const turn1 = h.startAgentRun('conversation-token', 'run-1');
      await h.navigateInRun(turn1, 'https://host/reset/a8f3b2c9d1e4f7a0b5c8d2e6f9a1?next=home');
      await h.runtime.endRun(turn1);

      expect(h.lastPageSecureStorage.values.size).toBe(0);

      const turn2 = h.startAgentRun('conversation-token', 'run-2');
      const observed = await h.observeInRun(turn2);
      const turn2Key = h.adapter.getBinding(turn2)!.serviceKey;
      expect(observed.output).toBe('URL: about:blank');
      expect(h.windows.get(turn2Key)!.navigate).not.toHaveBeenCalled();
      await h.runtime.endRun(turn2);
    } finally {
      h.cleanup();
    }
  });

  it('does not store from or restore into the personal-profile window', async () => {
    const h = createHarness();
    try {
      // 1) Ending a personal-profile run does not record a last page for the conversation.
      const userTurn1 = h.startUserRun('conversation-personal', 'user-1');
      await h.navigateInRun(userTurn1, 'https://host/personal/settings');
      expect(h.adapter.getBinding(userTurn1)!.serviceKey).toBe(MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY);
      await h.runtime.endRun(userTurn1);
      expect(h.lastPageSecureStorage.values.size).toBe(0);

      const agentTurn1 = h.startAgentRun('conversation-personal', 'agent-1');
      const agentObserved = await h.observeInRun(agentTurn1);
      const agentTurn1Key = h.adapter.getBinding(agentTurn1)!.serviceKey;
      expect(agentObserved.output).toBe('URL: about:blank');
      expect(h.windows.get(agentTurn1Key)!.navigate).not.toHaveBeenCalled();

      // 2) Even when the conversation has an agent last page, opening the personal window does not restore it.
      await h.navigateInRun(agentTurn1, 'https://host/pricing');
      await h.runtime.endRun(agentTurn1);
      expect(await h.lastPageStore.getForConversation('conversation-personal')).toBe('https://host/pricing');

      await h.personalWindow.raw.close();
      h.personalWindow.navigate.mockClear();
      const userTurn2 = h.startUserRun('conversation-personal', 'user-2');
      await h.observeInRun(userTurn2);
      expect(h.personalWindow.navigate).not.toHaveBeenCalled();
      await h.runtime.endRun(userTurn2);
    } finally {
      h.cleanup();
    }
  });

  it('does not navigate when claiming a kept or parked window', async () => {
    const h = createHarness();
    try {
      // Seed an earlier stored page so restore WOULD navigate if kept/parked claim were not excluded.
      const seedRun = h.startAgentRun('conversation-parked', 'run-seed');
      await h.navigateInRun(seedRun, 'https://host/earlier');
      await h.runtime.endRun(seedRun);
      expect(await h.lastPageStore.getForConversation('conversation-parked')).toBe('https://host/earlier');

      // Run 1 opens https://host/gate and parks for wait_for_user.
      const parkedRun = h.startAgentRun('conversation-parked', 'run-park');
      await h.navigateInRun(parkedRun, 'https://host/gate');
      const parkedBinding = h.adapter.getBinding(parkedRun)!;
      const parkedWindow = h.windows.get(parkedBinding.serviceKey)!;
      h.keptRegistry.register({
        conversationId: 'conversation-parked',
        serviceKey: parkedBinding.serviceKey,
        url: 'https://host/gate',
        title: 'Gate',
        browserService: parkedBinding.browserService,
        parkedForUser: true,
      });
      await h.runtime.endRun(parkedRun);
      expect(h.release).toHaveBeenCalledTimes(1); // only seedRun was closed

      parkedWindow.navigate.mockClear();
      const claimRun = h.startAgentRun('conversation-parked', 'run-claim');
      const claimed = await h.observeInRun(claimRun);
      expect(claimed.success).toBe(true);
      expect(claimed.output).toBe('URL: https://host/gate');
      expect(h.adapter.getBinding(claimRun)!.serviceKey).toBe(parkedBinding.serviceKey);
      expect(parkedWindow.navigate).not.toHaveBeenCalled();
      await h.runtime.endRun(claimRun);
    } finally {
      h.cleanup();
    }
  });

  it('logs a distinguishable warn and continues on about:blank when restore navigation throws', async () => {
    const h = createHarness();
    try {
      const turn1 = h.startAgentRun('conversation-fail', 'run-1');
      await h.navigateInRun(turn1, 'https://host/a/b?q=1#h');
      await h.runtime.endRun(turn1);

      const turn2 = h.startAgentRun('conversation-fail', 'run-2');
      // Pre-wire turn2's window so its navigate rejects during ensureBinding.
      const turn2PreviewService = h.adapter.getBrowserService(turn2);
      for (const win of h.windows.values()) {
        if (win.service === turn2PreviewService) {
          win.navigate.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'));
        }
      }

      const observed = await h.observeInRun(turn2);
      expect(observed.success).toBe(true);
      expect(observed.output).toBe('URL: about:blank');
      expect(h.resumeLogger.warn).toHaveBeenCalledTimes(1);
      expect(h.resumeLogger.warn).toHaveBeenCalledWith(
        'Failed to navigate to managed browser last page; continuing on blank page',
        expect.objectContaining({
          reason: 'last_page_navigation_failed',
          url: 'https://host/a/b',
          error: 'net::ERR_CONNECTION_REFUSED',
        }),
      );
      await h.runtime.endRun(turn2);
    } finally {
      h.cleanup();
    }
  });

  it('clears the stored last page when clearConversationResumeState runs on conversation deletion or reset', async () => {
    const h = createHarness();
    try {
      const turn1 = h.startAgentRun('conversation-reset', 'run-1');
      await h.navigateInRun(turn1, 'https://host/a/b?q=1#h');
      await h.runtime.endRun(turn1);
      expect(h.lastPageSecureStorage.values.size).toBe(1);

      await h.adapter.clearConversationResumeState('conversation-reset');
      expect(h.lastPageSecureStorage.values.size).toBe(0);
      expect(await h.lastPageStore.getForConversation('conversation-reset')).toBeNull();

      const turn2 = h.startAgentRun('conversation-reset', 'run-2');
      const observed = await h.observeInRun(turn2);
      const turn2Key = h.adapter.getBinding(turn2)!.serviceKey;
      expect(observed.output).toBe('URL: about:blank');
      expect(h.windows.get(turn2Key)!.navigate).not.toHaveBeenCalled();
      await h.runtime.endRun(turn2);
    } finally {
      h.cleanup();
    }
  });

  it('does not re-record the last page when a run still in flight releases after the conversation was cleared', async () => {
    const h = createHarness();
    try {
      const turn1 = h.startAgentRun('conversation-deleted', 'run-1');
      await h.navigateInRun(turn1, 'https://host/a/b?q=1#h');

      await h.adapter.clearConversationResumeState('conversation-deleted');
      await h.runtime.endRun(turn1);
      expect(h.lastPageSecureStorage.values.size).toBe(0);

      // Reactivating the conversation (reset to a new session id reuse) records again.
      h.adapter.activateConversationResumeState('conversation-deleted');
      const turn2 = h.startAgentRun('conversation-deleted', 'run-2');
      await h.navigateInRun(turn2, 'https://host/c');
      await h.runtime.endRun(turn2);
      expect(await h.lastPageStore.getForConversation('conversation-deleted')).toBe('https://host/c');
    } finally {
      h.cleanup();
    }
  });
});
