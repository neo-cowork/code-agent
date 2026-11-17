import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/host/tools/types';
import type { BrowserResumeStateStore } from '../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';

const holder = vi.hoisted(() => ({ adapter: null as unknown }));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async () => undefined }),
}));
vi.mock('../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter')>();
  return { ...actual, getManagedBrowserProviderAdapter: () => holder.adapter as never };
});

import { ManagedBrowserProviderAdapter } from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import { setBrowserLaunchResumeHook } from '../../../../src/host/services/infra/browser/launchResumeHook';
import { SurfaceExecutionRuntime } from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { getBrowserService } from '../../../../src/host/services/infra/browserPool';
import { browserService as singleton } from '../../../../src/host/services/infra/browserService';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { browserActionTool } from '../../../../src/host/tools/vision/browserAction';
import { ensureManagedBrowserSessionForWorkbench } from '../../../../src/host/tools/vision/browserWorkbenchIntent';
import { registerDesktopHandlers } from '../../../../src/host/ipc/desktop.ipc';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../../src/shared/ipc';

const LAST_URL = 'https://site.test/dashboard';

interface Fake { navigations: string[]; emitted: string[]; imports: string[]; running: () => boolean }

/** Real BrowserService instance; only the Chrome process/page seams are replaced. */
function arm(service: BrowserService): Fake {
  const s = service as unknown as Record<string, any>;
  let url = 'about:blank';
  let hasTab = false;
  const fake: Fake = { navigations: [], emitted: [], imports: [], running: () => service.isRunning() };
  const launch = async () => { s.context = {}; s.browser = {}; };
  vi.spyOn(s, 'launchSystemChromeCdp').mockImplementation(launch);
  vi.spyOn(s, 'launchPlaywrightBundled').mockImplementation(launch);
  vi.spyOn(s, 'installContextGuards').mockResolvedValue(undefined);
  vi.spyOn(s, 'newTab').mockImplementation(async (...args: unknown[]) => { hasTab = true; if (typeof args[0] === 'string') url = args[0]; return 'tab-1'; });
  vi.spyOn(s, 'getActiveTab').mockImplementation(() => (hasTab ? { id: 'tab-1', url, title: '' } : null));
  vi.spyOn(s, 'navigate').mockImplementation(async (...args: unknown[]) => { url = String(args[0]); fake.navigations.push(url); s.emitSessionChanged('navigate'); });
  vi.spyOn(s, 'close').mockImplementation(async () => { s.context = null; s.browser = null; hasTab = false; url = 'about:blank'; });
  vi.spyOn(s, 'getDomSnapshot').mockImplementation(async () => ({ snapshotId: 's', tabId: 'tab-1', url, title: '', capturedAtMs: Date.now(), headings: [], interactiveElements: [] }));
  service.onSessionChanged((reason) => fake.emitted.push(reason));
  return fake;
}

function setup() {
  const resume: BrowserResumeStateStore = {
    importForConversation: vi.fn(async () => true),
    exportForConversation: vi.fn(async () => ''),
    clearConversation: vi.fn(async () => {}),
    activateConversation: vi.fn(),
  };
  const adapter = new ManagedBrowserProviderAdapter(new SurfaceExecutionRuntime({ runRegistry: new RunRegistry() }), undefined, undefined, resume);
  holder.adapter = adapter;
  const lastPages = (adapter as unknown as { lastPageStore: { recordForConversation(c: string, u: string): Promise<void> } }).lastPageStore;
  return { adapter, resume, lastPages };
}

const ctx = (sessionId: string) => ({ sessionId, workingDirectory: '/tmp', requestPermission: async () => true }) as unknown as ToolContext;

let service: BrowserService;
let fake: Fake;
beforeEach(() => {
  service = getBrowserService();
  fake = arm(service);
});
afterEach(async () => {
  await service.close();
  vi.restoreAllMocks();
  setBrowserLaunchResumeHook(null);
});

describe('BrowserService launch layer resume hook', () => {
  it('cold launch restores last page + login state, and the reused window switches conversation with a session refresh', async () => {
    const { resume, lastPages } = setup();
    await lastPages.recordForConversation('conv-a', LAST_URL);
    await lastPages.recordForConversation('conv-b', 'https://site.test/other');

    await service.launch({ leaseOwner: 'test', conversationId: 'conv-a' });
    expect(fake.navigations).toEqual([LAST_URL]);
    expect(resume.importForConversation).toHaveBeenCalledWith('conv-a', service);
    // the consumed login slot is put back so another window of the same conversation can still restore it
    expect(resume.exportForConversation).toHaveBeenCalledWith('conv-a', service);

    // same conversation, window already on its page: no second navigation
    await service.launch({ leaseOwner: 'test', conversationId: 'conv-a' });
    expect(fake.navigations).toEqual([LAST_URL]);

    // different conversation on the already-running window: switches and refreshes the view
    fake.emitted.length = 0;
    await service.launch({ leaseOwner: 'test', conversationId: 'conv-b' });
    expect(fake.navigations).toEqual([LAST_URL, 'https://site.test/other']);
    expect(fake.emitted).toContain('navigate');
    expect(fake.emitted.at(-1)).toBe('launch');
  });

  it('ensureSession on a running window also restores (reuse branch)', async () => {
    const { lastPages } = setup();
    await lastPages.recordForConversation('conv-a', LAST_URL);
    await service.launch({ leaseOwner: 'other' });
    await service.ensureSession('about:blank', { leaseOwner: 'test', conversationId: 'conv-a' });
    expect(fake.navigations).toEqual([LAST_URL]);
  });

  it('a conversation without conversationId or without a recorded page is left alone', async () => {
    const { lastPages } = setup();
    await lastPages.recordForConversation('conv-a', LAST_URL);
    await service.launch({ leaseOwner: 'test' });
    await service.launch({ leaseOwner: 'test', conversationId: 'conv-never-visited' });
    expect(fake.navigations).toEqual([]);
  });

  it('a failing import is logged and never blocks the launch', async () => {
    const { resume, lastPages } = setup();
    vi.mocked(resume.importForConversation).mockRejectedValueOnce(new Error('boom'));
    await lastPages.recordForConversation('conv-a', LAST_URL);
    await service.launch({ leaseOwner: 'test', conversationId: 'conv-a' });
    expect(service.isRunning()).toBe(true);
    expect(fake.navigations).toEqual([LAST_URL]);
  });
});

describe('entries pass through the launch layer hook once', () => {
  it('browser_action launch', async () => {
    const { lastPages } = setup();
    await lastPages.recordForConversation('conv-a', LAST_URL);
    const result = await browserActionTool.execute({ action: 'launch' }, ctx('conv-a'));
    expect(result.success).toBe(true);
    expect(fake.navigations).toEqual([LAST_URL]);
  });

  it('workbench auto-open', async () => {
    const { lastPages } = setup();
    await lastPages.recordForConversation('conv-a', LAST_URL);
    await ensureManagedBrowserSessionForWorkbench({ conversationId: 'conv-a' });
    expect(fake.navigations).toEqual([LAST_URL]);
  });

  it('desktop ipc ensureManagedBrowserSession', async () => {
    const { lastPages } = setup();
    await lastPages.recordForConversation('conv-a', LAST_URL);
    arm(singleton);
    const handlers = new Map<string, (event: unknown, request: IPCRequest) => Promise<IPCResponse>>();
    registerDesktopHandlers({ handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never);
    const res = await handlers.get(IPC_DOMAINS.DESKTOP)!(null, { action: 'ensureManagedBrowserSession', payload: { conversationId: 'conv-a', profileMode: 'persistent' } } as IPCRequest);
    expect(res.success).toBe(true);
    expect((singleton.navigate as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0])).toEqual([LAST_URL]);
    await singleton.close();
  });

  it('adapter explicit identity path restores exactly once (hook stays out)', async () => {
    const registry = new RunRegistry();
    registry.startAuxiliary({ runId: 'run-a', sessionId: 'conv-a', workspace: process.cwd() });
    const resume = setup().resume;
    const adapter = new ManagedBrowserProviderAdapter(new SurfaceExecutionRuntime({ runRegistry: registry }), () => service, async () => {}, resume);
    const lastPages = (adapter as unknown as { lastPageStore: { recordForConversation(c: string, u: string): Promise<void> } }).lastPageStore;
    await lastPages.recordForConversation('conv-a', LAST_URL);
    const result = await adapter.execute({
      identity: { conversationId: 'conv-a', runId: 'run-a', agentId: 'agent-a' },
      operationId: 'op-1',
      action: 'navigate',
      params: { action: 'navigate', url: 'https://site.test/next' },
      async executeProvider(_signal, browserService) {
        await browserService.navigate('https://site.test/next');
        return { success: true, output: 'ok' };
      },
    });
    expect(result.error ?? '').toBe('');
    // restore once (adapter path), then the run's own navigation; the launch hook adds nothing
    expect(fake.navigations).toEqual([LAST_URL, 'https://site.test/next']);
    expect(resume.importForConversation).toHaveBeenCalledTimes(1);
  });
});
