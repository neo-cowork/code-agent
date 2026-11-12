// N-BROWSER-KEEP-RESULT-PAGE-FU1：getKeptResultPage / adoptKeptResultPage 经已注册的
// WORKSPACE IPC handler 的 none / kept / closed 三态 + adopt 成功/失败（registry 用真实实现）。
import { describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest } from '../../../src/shared/ipc';
import { registerWorkspaceHandlers } from '../../../src/host/ipc/workspace.ipc';
import type { IpcMain } from '../../../src/host/platform';
import type { UserBrowserLinkService } from '../../../src/host/services/surfaceExecution/UserBrowserLinkService';
import { KeptBrowserRegistry } from '../../../src/host/services/surfaceExecution/keptBrowserRegistry';

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
    keptState: (conversationId: string) => registry.snapshot(conversationId.trim()),
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
      .toEqual({ state: 'none', url: null, title: null });

    registry.register({
      conversationId: 'c1',
      serviceKey: 'surface-1',
      url: 'https://example.test/done',
      title: 'Done',
      browserService: { onSessionChanged: (listener: (reason: string) => void) => { unsubscribe.current = listener; return () => undefined; } } as never,
    });
    expect((await call('getKeptResultPage', { conversationId: 'c1' })).data)
      .toEqual({ state: 'kept', url: 'https://example.test/done', title: 'Done' });

    unsubscribe.current?.('close');
    expect((await call('getKeptResultPage', { conversationId: 'c1' })).data)
      .toEqual({ state: 'closed', url: 'https://example.test/done', title: 'Done' });
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

  it('adoptKeptResultPage surfaces the plain failure sentence when nothing is kept', async () => {
    const adopt = vi.fn(async () => { throw new Error('No kept result page is open for this conversation.'); });
    const { call } = setup(adopt as unknown as Links['adopt']);
    const response = await call('adoptKeptResultPage', { conversationId: 'c1', workspace: '/tmp/ws' });
    expect(response.success).toBe(false);
    expect(JSON.stringify(response.error)).toContain('No kept result page is open for this conversation.');
  });
});
