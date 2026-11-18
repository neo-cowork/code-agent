import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  userData: '',
  currentUrl: 'about:blank',
  gotoError: null as Error | null,
  cookies: [] as Array<{ name?: string }>,
  initScripts: [] as unknown[][],
  ownerAtGoto: null as string | null,
  readOwner: null as (() => string | null) | null,
  importCount: 0,
  storageError: null as Error | null,
}));

vi.mock('../../../../src/host/platform', () => ({
  app: { getPath: () => state.userData, getAppPath: () => state.userData },
  broadcastToRenderer: vi.fn(),
}));

vi.mock('../../../../src/host/services/infra/browser/browserLaunchHelpers', () => ({
  getPlaywrightProxyOptions: vi.fn(),
  launchSystemChromeCdpBrowser: vi.fn(),
  launchPlaywrightBundledBrowser: vi.fn(async () => ({
    browser: { close: vi.fn(async () => {}), isConnected: () => true },
    context: {
      on: vi.fn(),
      close: vi.fn(async () => {
        state.currentUrl = 'about:blank';
        state.cookies = [];
      }),
      addInitScript: vi.fn(async (...args: unknown[]) => { state.initScripts.push(args); }),
      route: vi.fn(async () => undefined),
      newPage: vi.fn(async () => {
        state.currentUrl = 'about:blank';
        return {
          setViewportSize: async () => undefined,
          url: () => state.currentUrl,
          title: async () => 'Fixture',
          on: () => undefined,
          goto: async (url: string) => {
            state.ownerAtGoto = state.readOwner?.() ?? null;
            if (state.gotoError) {
              const error = state.gotoError;
              state.gotoError = null;
              state.currentUrl = 'chrome-error://chromewebdata/';
              throw error;
            }
            state.currentUrl = url;
          },
          evaluate: async () => 0,
          context: () => { throw new Error('no cdp session in fixture'); },
        };
      }),
      addCookies: vi.fn(async (cookies: Array<{ name?: string }>) => {
        state.importCount += 1;
        state.cookies.push(...cookies);
      }),
      storageState: vi.fn(async (options?: { path?: string }) => {
        if (state.storageError) throw state.storageError;
        const saved = { cookies: state.cookies, origins: [] };
        if (options?.path) await fs.writeFile(options.path, JSON.stringify(saved));
        return saved;
      }),
    },
    executable: 'fixture-browser',
    missingExecutable: false,
    recommendedAction: null,
  })),
}));

const DEMO_ORIGIN = 'http://127.0.0.1:9';
const DASHBOARD = `${DEMO_ORIGIN}/dashboard`;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value); },
    removeItem: vi.fn(async (key: string) => { values.delete(key); }),
  };
}

function resumeSlot(conversationId: string): string {
  return `browser-resume:${createHash('sha256').update(conversationId).digest('hex')}`;
}

let scratch = '';

async function boot() {
  vi.resetModules();
  const { BrowserService } = await import('../../../../src/host/services/infra/browserService');
  const { installManagedBrowserLaunchResume } = await import('../../../../src/host/services/surfaceExecution/browserLaunchResume');
  const { SecureBrowserResumeStateStore } = await import('../../../../src/host/services/surfaceExecution/BrowserResumeStateStore');
  const { SecureBrowserLastPageStore } = await import('../../../../src/host/services/surfaceExecution/browserLastPageStore');
  const secure = memoryStorage();
  const lastPages = memoryStorage();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const resume = new SecureBrowserResumeStateStore({
    rootDir: path.join(scratch, 'resume'),
    secureStorage: secure,
    workspaceRoot: process.cwd(),
  });
  const lastPage = new SecureBrowserLastPageStore({ secureStorage: lastPages });
  installManagedBrowserLaunchResume({ resumeStateStore: resume, lastPageStore: lastPage, logger });
  const service = new BrowserService('launch-resume');
  state.readOwner = () => service.getResumeOwner();
  return { service, secure, lastPage, logger, resume, BrowserService };
}

const launchOptions = {
  provider: 'playwright-bundled' as const,
  mode: 'headless' as const,
  profileMode: 'isolated' as const,
};

function resumeLogs(logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }) {
  return [...logger.info.mock.calls, ...logger.warn.mock.calls]
    .filter((call) => call[0] === 'Managed browser launch resume')
    .map((call) => call[1] as { phase: string; reason: string; conversationIdHash: string; url: string | null });
}

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-launch-resume-'));
  state.userData = path.join(scratch, 'user-data');
  await fs.mkdir(state.userData, { recursive: true });
  state.currentUrl = 'about:blank';
  state.gotoError = null;
  state.cookies = [];
  state.initScripts = [];
  state.ownerAtGoto = null;
  state.readOwner = null;
  state.importCount = 0;
  state.storageError = null;
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('BrowserService launch resume', () => {
  it('seeds a fresh isolated jar, sets the owner before navigation, and keeps the archive', async () => {
    const { service, secure, lastPage, logger, BrowserService } = await boot();
    await secure.setItem(resumeSlot('chat-a'), JSON.stringify({
      cookies: [{ name: 'demo_session', value: '1', domain: '127.0.0.1', path: '/' }],
      origins: [{ origin: DEMO_ORIGIN, localStorage: [{ name: 'who', value: 'demo' }] }],
    }));
    await lastPage.recordForConversation('chat-a', `${DASHBOARD}?q=1#h`);

    await service.launch({ ...launchOptions, conversationId: 'chat-a' });

    expect(service.getResumeOwner()).toBe('chat-a');
    expect(state.ownerAtGoto).toBe('chat-a');
    expect(state.currentUrl).toBe(DASHBOARD);
    expect(state.cookies.map((cookie) => cookie.name)).toEqual(['demo_session']);
    expect(state.importCount).toBe(1);
    expect(secure.values.get(resumeSlot('chat-a'))).toContain('demo_session');
    expect(secure.removeItem).not.toHaveBeenCalled();
    const originScript = state.initScripts.find((args) => Array.isArray(args[1])
      && (args[1] as Array<{ origin?: string; localStorage?: Array<{ name: string; value: string }> }>)
        .some((origin) => origin.origin === DEMO_ORIGIN && origin.localStorage?.some((item) => item.name === 'who' && item.value === 'demo')));
    expect(originScript).toBeTruthy();
    const [line] = resumeLogs(logger);
    expect(line).toMatchObject({ phase: 'cold', reason: 'last_page_restored', url: DASHBOARD });
    expect(line.conversationIdHash).not.toBe('chat-a');
    expect(JSON.stringify(line)).not.toContain('chat-a');
    await service.close();

    const again = new BrowserService('launch-resume-again');
    state.readOwner = () => again.getResumeOwner();
    await again.launch({ ...launchOptions, conversationId: 'chat-a' });
    expect(state.importCount).toBe(2);
    expect(state.cookies.map((cookie) => cookie.name)).toEqual(['demo_session']);
    expect(secure.removeItem).not.toHaveBeenCalled();
    await again.close();
  });

  it('refreshes a blank tab for the same owner without importing again', async () => {
    const { service, lastPage, logger } = await boot();
    await lastPage.recordForConversation('chat-a', DASHBOARD);
    await service.launch({ ...launchOptions, conversationId: 'chat-a' });
    state.currentUrl = 'about:blank';
    logger.info.mockClear();

    await service.ensureSession('about:blank', { ...launchOptions, conversationId: 'chat-a' });

    expect(state.currentUrl).toBe(DASHBOARD);
    expect(state.importCount).toBe(0);
    expect(resumeLogs(logger)).toEqual([
      expect.objectContaining({ phase: 'reuse-same', reason: 'last_page_restored', url: DASHBOARD }),
    ]);
    await service.close();
  });

  it('swaps an idle window to the other conversation exactly once', async () => {
    const { service, secure, logger } = await boot();
    await secure.setItem(resumeSlot('chat-a'), JSON.stringify({
      cookies: [{ name: 'demo_session', value: 'a', domain: '127.0.0.1', path: '/' }],
      origins: [],
    }));
    await service.launch({ ...launchOptions, conversationId: 'chat-a' });
    state.importCount = 0;

    await service.ensureSession('about:blank', { ...launchOptions, conversationId: 'chat-b' });

    expect(service.getResumeOwner()).toBe('chat-b');
    expect(service.isRunning()).toBe(true);
    expect(state.cookies).toEqual([]);
    expect(state.importCount).toBe(0);
    expect(secure.values.get(resumeSlot('chat-a'))).toContain('demo_session');
    const lines = resumeLogs(logger);
    expect(lines.filter((line) => line.phase === 'swap')).toHaveLength(1);
    expect(lines.filter((line) => line.phase === 'cold')).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({ phase: 'swap', reason: 'resume_seeded' });
    await service.close();
  });

  it('skips a busy window and an unowned real page without touching cookies', async () => {
    const busy = await boot();
    await busy.service.launch({ ...launchOptions, conversationId: 'chat-a' });
    busy.service.setLeaseInUse(true);
    state.importCount = 0;
    await busy.service.ensureSession('about:blank', { ...launchOptions, conversationId: 'chat-b' });
    expect(busy.service.getResumeOwner()).toBe('chat-a');
    expect(state.importCount).toBe(0);
    expect(resumeLogs(busy.logger).at(-1)).toMatchObject({
      phase: 'skipped',
      reason: 'resume_skipped_window_busy',
    });
    await busy.service.close();

    const unowned = await boot();
    await unowned.service.ensureSession(DASHBOARD, launchOptions);
    expect(unowned.service.getResumeOwner()).toBeNull();
    expect(state.currentUrl).toBe(DASHBOARD);
    await unowned.service.ensureSession('about:blank', { ...launchOptions, conversationId: 'chat-b' });
    expect(state.currentUrl).toBe(DASHBOARD);
    expect(state.importCount).toBe(0);
    expect(resumeLogs(unowned.logger).at(-1)).toMatchObject({
      phase: 'skipped',
      reason: 'resume_skipped_unowned',
    });
    await unowned.service.close();
  });

  it('does not close a persistent personal window when an isolated launch reuses it', async () => {
    const { service, secure, logger } = await boot();
    await service.launch({ provider: 'playwright-bundled', mode: 'headless', profileMode: 'persistent' });
    state.cookies = [{ name: 'personal_session' }];

    await service.ensureSession('about:blank', { ...launchOptions, conversationId: 'chat-b' });

    expect(service.isRunning()).toBe(true);
    expect(service.getResumeOwner()).toBeNull();
    expect(state.cookies.map((cookie) => cookie.name)).toEqual(['personal_session']);
    expect(secure.values.size).toBe(0);
    expect(resumeLogs(logger)).toEqual([]);
    await service.close();
  });

  it('does not overwrite a newer login archive with the window\'s stale cookies on swap', async () => {
    const { service, secure, resume } = await boot();
    await service.launch({ ...launchOptions, conversationId: 'chat-a' });
    state.cookies = [{ name: 'newer_login' }];
    await resume.exportForConversation('chat-a', service);
    state.cookies = [{ name: 'stale_login' }];

    await service.ensureSession('about:blank', { ...launchOptions, conversationId: 'chat-b' });

    expect(service.getResumeOwner()).toBe('chat-b');
    expect(secure.values.get(resumeSlot('chat-a'))).toContain('newer_login');
    expect(secure.values.get(resumeSlot('chat-a'))).not.toContain('stale_login');
    await service.close();
  });

  it('fails the launch and keeps the window with its owner when the old login cannot be saved', async () => {
    const { service } = await boot();
    await service.launch({ ...launchOptions, conversationId: 'chat-a' });
    state.storageError = new Error('storage state unavailable');

    await expect(
      service.ensureSession('about:blank', { ...launchOptions, conversationId: 'chat-b' }),
    ).rejects.toMatchObject({ code: 'BROWSER_RESUME_STATE_EXPORT_FAILED' });

    expect(service.getResumeOwner()).toBe('chat-a');
    expect(service.isRunning()).toBe(true);
    state.storageError = null;
    await service.close();
  });

  it('keeps the owner when navigation fails and retries on the next launch', async () => {
    const { service, secure, lastPage, logger } = await boot();
    await secure.setItem(resumeSlot('chat-a'), JSON.stringify({
      cookies: [{ name: 'demo_session', value: '1', domain: '127.0.0.1', path: '/' }],
      origins: [],
    }));
    await lastPage.recordForConversation('chat-a', DASHBOARD);
    state.gotoError = new Error('net::ERR_CONNECTION_REFUSED');

    await service.launch({ ...launchOptions, conversationId: 'chat-a' });

    expect(service.getResumeOwner()).toBe('chat-a');
    expect(state.ownerAtGoto).toBe('chat-a');
    expect(state.currentUrl).toBe('chrome-error://chromewebdata/');
    expect(state.importCount).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith('Managed browser launch resume', expect.objectContaining({
      phase: 'cold',
      reason: 'last_page_navigation_failed',
      url: DASHBOARD,
      error: 'net::ERR_CONNECTION_REFUSED',
    }));

    await service.ensureSession('about:blank', { ...launchOptions, conversationId: 'chat-a' });

    expect(service.getResumeOwner()).toBe('chat-a');
    expect(state.currentUrl).toBe(DASHBOARD);
    expect(state.importCount).toBe(1);
    expect(logger.info).toHaveBeenCalledWith('Managed browser launch resume', expect.objectContaining({
      phase: 'reuse-same',
      reason: 'last_page_restored',
      url: DASHBOARD,
    }));
    await service.close();
  });
});
