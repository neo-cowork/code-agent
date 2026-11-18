import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { SecureBrowserResumeStateStore } from '../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';
import { SecureBrowserLastPageStore } from '../../../../src/host/services/surfaceExecution/browserLastPageStore';
import { createBrowserLaunchResumeHook } from '../../../../src/host/services/surfaceExecution/browserLaunchResume';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (k: string) => values.get(k) ?? null,
    setItem: async (k: string, v: string) => { values.set(k, v); },
    removeItem: async (k: string) => { values.delete(k); },
  };
}

function fakeWindow(opts: { windowState: object; failNavigations?: number }) {
  let url = 'about:blank';
  let failures = opts.failNavigations ?? 0;
  const navigations: string[] = [];
  const service = {
    getActiveTab: () => ({ id: 'tab-1', url, title: '' }),
    newTab: vi.fn(async () => 'tab-1'),
    navigate: vi.fn(async (next: string) => {
      if (failures > 0) { failures -= 1; throw new Error('net::ERR_FAILED'); }
      url = next; navigations.push(next);
    }),
    exportStorageState: vi.fn(async (file: string) => { await fs.promises.writeFile(file, JSON.stringify(opts.windowState), 'utf8'); }),
    importStorageState: vi.fn(async () => undefined),
  };
  return { service: service as unknown as BrowserService, navigations, setUrl: (next: string) => { url = next; } };
}

function setup() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-resume-iso-'));
  const resumeStorage = memoryStorage();
  const resumeStateStore = new SecureBrowserResumeStateStore({ rootDir, secureStorage: resumeStorage, workspaceRoot: process.cwd() });
  const lastPageStore = new SecureBrowserLastPageStore({ secureStorage: memoryStorage() });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const hook = createBrowserLaunchResumeHook({ resumeStateStore, lastPageStore, logger });
  const slotKey = () => [...resumeStorage.values.keys()].find((k) => k.startsWith('browser-resume:'));
  return { hook, resumeStorage, resumeStateStore, lastPageStore, slotKey };
}

const ARCHIVE = {
  cookies: [{ name: 'sess', value: 'A-archived', domain: 'site.test', path: '/' }],
  origins: [{ origin: 'https://site.test', localStorage: [{ name: 'draft', value: 'kept' }] }],
};

describe('launch-layer resume keeps the saved archive intact', () => {
  it('(i) a slot with localStorage origins still has them, unchanged, after a launch-layer import', async () => {
    const { hook, resumeStorage, resumeStateStore } = setup();
    await resumeStateStore.exportForConversation('conv-a', fakeWindow({ windowState: ARCHIVE }).service);
    const before = [...resumeStorage.values.values()][0];
    // the live window only holds a cookie: re-exporting it would drop the localStorage origins
    const win = fakeWindow({ windowState: { cookies: [{ name: 'other', value: 'x' }], origins: [] } });
    await hook({ service: win.service, conversationId: 'conv-a', phase: 'cold' });
    expect([...resumeStorage.values.values()]).toEqual([before]);
    expect(JSON.parse([...resumeStorage.values.values()][0]).origins).toEqual(ARCHIVE.origins);
  });

  it('(ii) a reused window holding conversation A cookies leaves none of them in conversation B slot', async () => {
    const { hook, resumeStorage, resumeStateStore, slotKey } = setup();
    const archiveB = { cookies: [{ name: 'sess', value: 'B-archived' }], origins: [] };
    await resumeStateStore.exportForConversation('conv-b', fakeWindow({ windowState: archiveB }).service);
    const keyB = slotKey()!;
    const windowOfA = fakeWindow({ windowState: { cookies: [{ name: 'sess', value: 'A-live' }], origins: [] } });
    await hook({ service: windowOfA.service, conversationId: 'conv-b', phase: 'reuse' });
    const stored = resumeStorage.values.get(keyB);
    expect(stored).toBeDefined();
    expect(stored).not.toContain('A-live');
    expect(JSON.parse(stored!).cookies).toEqual(archiveB.cookies);
  });
});

describe('last page restore ownership', () => {
  it('a failed restore navigation is retried by the next launch of the same window and conversation', async () => {
    const { hook, lastPageStore } = setup();
    await lastPageStore.recordForConversation('conv-a', 'https://site.test/dashboard');
    const win = fakeWindow({ windowState: { cookies: [], origins: [] }, failNavigations: 1 });
    await hook({ service: win.service, conversationId: 'conv-a', phase: 'cold' });
    expect(win.navigations).toEqual([]);
    win.setUrl('about:blank');
    await hook({ service: win.service, conversationId: 'conv-a', phase: 'reuse' });
    expect(win.navigations).toEqual(['https://site.test/dashboard']);
  });

  it('a failed restore on a window already showing a page is still retried', async () => {
    const { hook, lastPageStore } = setup();
    await lastPageStore.recordForConversation('conv-a', 'https://site.test/dashboard');
    const win = fakeWindow({ windowState: { cookies: [], origins: [] }, failNavigations: 1 });
    win.setUrl('https://site.test/other');
    await hook({ service: win.service, conversationId: 'conv-a', phase: 'reuse' });
    await hook({ service: win.service, conversationId: 'conv-a', phase: 'reuse' });
    expect(win.navigations).toEqual(['https://site.test/dashboard']);
  });
});
