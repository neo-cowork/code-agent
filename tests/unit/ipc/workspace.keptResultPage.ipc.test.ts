// N-BROWSER-KEEP-RESULT-PAGE-FU1：getKeptResultPage / adoptKeptResultPage 经已注册的
// WORKSPACE IPC handler 的 none / kept / closed 三态 + adopt 成功/失败（registry 用真实实现）。
import { describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest } from '../../../src/shared/ipc';
import { registerWorkspaceHandlers } from '../../../src/host/ipc/workspace.ipc';
import type { IpcMain } from '../../../src/host/platform';
import type { UserBrowserLinkService } from '../../../src/host/services/surfaceExecution/UserBrowserLinkService';
import { KEPT_RESULT_PAGE_SNAPSHOT_MAX_CHARS } from '../../../src/shared/constants';
import { KeptBrowserRegistry } from '../../../src/host/services/surfaceExecution/keptBrowserRegistry';
import { captureKeptResultSnapshot } from '../../../src/host/services/surfaceExecution/keptResultSnapshot';

type Links = Pick<
  UserBrowserLinkService,
  'open' | 'end' | 'history' | 'dispatchUserInput' | 'setViewport' | 'adopt' | 'keptState'
>;

function setup(adopt: Links['adopt']) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  } as unknown as IpcMain;
  const pool = { setKept: vi.fn(), releaseAgent: vi.fn(async () => undefined) };
  const registry = new KeptBrowserRegistry(pool);
  const links = {
    open: vi.fn(), end: vi.fn(), history: vi.fn(), dispatchUserInput: vi.fn(), setViewport: vi.fn(),
    adopt,
    keptState: (conversationId: string, options?: { includeSnapshot?: boolean }) =>
      registry.snapshot(conversationId.trim(), options),
  } as unknown as Links;
  registerWorkspaceHandlers(ipcMain, () => null, () => null, () => null, () => links);
  const call = async (action: string, payload: unknown) =>
    await handlers.get(IPC_DOMAINS.WORKSPACE)?.({}, { action, payload } satisfies IPCRequest) as
      { success: boolean; data?: unknown; error?: { message?: string } | string };
  return { registry, call };
}

describe('workspace kept result page IPC', () => {
  it('getKeptResultPage reports none / kept / closed with url and title', async () => {
    const { registry, call } = setup(vi.fn());
    const unsubscribe = { current: undefined as ((reason: string) => void) | undefined };
    expect((await call('getKeptResultPage', { conversationId: 'c1' })).data)
      .toEqual({ state: 'none', url: null, title: null, reason: null });

    registry.register({
      conversationId: 'c1',
      serviceKey: 'surface-1',
      url: 'https://example.test/done',
      title: 'Done',
      browserService: { onSessionChanged: (listener: (reason: string) => void) => { unsubscribe.current = listener; return () => undefined; } } as never,
    });
    expect((await call('getKeptResultPage', { conversationId: 'c1' })).data)
      .toEqual({ state: 'kept', url: 'https://example.test/done', title: 'Done', reason: 'keep_result_page', reopenMode: 'url' });

    unsubscribe.current?.('close');
    expect((await call('getKeptResultPage', { conversationId: 'c1' })).data)
      .toEqual({ state: 'closed', url: 'https://example.test/done', title: 'Done', reason: 'keep_result_page', reopenMode: 'url' });
  });

  it('includeSnapshot returns HTML only on request, and a query URL stays on the url path', async () => {
    const { registry, call } = setup(vi.fn());
    registry.register({
      conversationId: 'c1',
      serviceKey: 'surface-1',
      url: 'http://127.0.0.1/signup-direct',
      title: 'Done',
      browserService: { onSessionChanged: () => () => undefined } as never,
    });
    expect(registry.setSnapshot('c1', '<h1>Signup success, Lee</h1>', 'surface-1')).toBe(true);

    const polled = await call('getKeptResultPage', { conversationId: 'c1' });
    expect(polled.data).toEqual({
      state: 'kept',
      url: 'http://127.0.0.1/signup-direct',
      title: 'Done',
      reason: 'keep_result_page',
      reopenMode: 'snapshot',
    });
    expect(polled.data).not.toHaveProperty('snapshotHtml');

    const detailed = await call('getKeptResultPage', { conversationId: 'c1', includeSnapshot: true });
    expect(detailed.data).toMatchObject({
      reopenMode: 'snapshot',
      snapshotHtml: '<h1>Signup success, Lee</h1>',
    });

    registry.register({
      conversationId: 'c1',
      serviceKey: 'surface-1',
      url: 'http://127.0.0.1/done?id=abc',
      title: 'Done',
      browserService: { onSessionChanged: () => () => undefined } as never,
    });
    expect(registry.setSnapshot('c1', '<h1>Signup success, Lee</h1>', 'surface-1')).toBe(true);
    const prg = await call('getKeptResultPage', { conversationId: 'c1' });
    expect(prg.data).toMatchObject({ reopenMode: 'url' });
    expect(prg.data).not.toHaveProperty('snapshotHtml');

    registry.markClosed('c1');
    const closed = await call('getKeptResultPage', { conversationId: 'c-missing' });
    expect(closed.data).toEqual({ state: 'none', url: null, title: null, reason: null });
  });

  it('capture failure and an over-cap page do not promise a snapshot', async () => {
    const { registry, call } = setup(vi.fn());
    registry.register({
      conversationId: 'c1',
      serviceKey: 'surface-1',
      url: 'http://127.0.0.1/done-flash',
      title: 'Done',
      browserService: { onSessionChanged: () => () => undefined } as never,
    });
    await captureKeptResultSnapshot({
      registry,
      conversationId: 'c1',
      serviceKey: 'surface-1',
      getPageHTML: async () => { throw new Error('tab closed'); },
      phase: 'keep',
    });
    await captureKeptResultSnapshot({
      registry,
      conversationId: 'c1',
      serviceKey: 'surface-1',
      getPageHTML: async () => 'y'.repeat(KEPT_RESULT_PAGE_SNAPSHOT_MAX_CHARS + 1),
      phase: 'release',
    });
    const view = await call('getKeptResultPage', { conversationId: 'c1', includeSnapshot: true });
    expect(view.data).toMatchObject({ state: 'kept', reopenMode: 'url' });
    expect(view.data).not.toHaveProperty('snapshotHtml');
  });

  it('adoptKeptResultPage forwards the conversation and workspace and returns the snapshot', async () => {
    const result = { conversationId: 'c1', runId: 'user-run', surfaceSessionId: 'surface-user', snapshot: { version: 1, conversationId: 'c1', sessions: [], updatedAt: 1 } };
    const adopt = vi.fn(async () => result);
    const { call } = setup(adopt as unknown as Links['adopt']);
    const response = await call('adoptKeptResultPage', { conversationId: 'c1', workspace: '/tmp/ws' });
    expect(response.success).toBe(true);
    expect(response.data).toEqual(result);
    expect(adopt).toHaveBeenCalledWith({ conversationId: 'c1', workspace: '/tmp/ws' });
  });

  it('adoptKeptResultPage surfaces the plain Chinese sentence and hides the raw error', async () => {
    const adopt = vi.fn(async () => { throw new Error('No kept result page is open for this conversation.'); });
    const { call } = setup(adopt as unknown as Links['adopt']);
    const response = await call('adoptKeptResultPage', { conversationId: 'c1', workspace: '/tmp/ws' });
    expect(response.success).toBe(false);
    expect(JSON.stringify(response.error)).toContain('这一页的浏览器窗口已经关闭');
  });
});
