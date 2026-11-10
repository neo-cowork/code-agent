import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAccount, ChannelAccountConfig } from '../../../src/shared/contract/channel';
import type { ChannelManager } from '../../../src/host/channels/channelManager';
import { CHANNEL_CHANNELS } from '../../../src/shared/ipc/channels';

const state = vi.hoisted(() => ({
  data: new Map<string, string>(),
  set: vi.fn((key: string, value: string) => { state.data.set(key, value); }),
  manager: null as ChannelManager | null,
}));
vi.mock('../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => ({ get: (key: string) => state.data.get(key), set: state.set }),
}));
vi.mock('../../../src/host/channels', () => ({ getChannelManager: () => state.manager }));

async function freshManager() {
  vi.resetModules();
  const { ChannelManager } = await import('../../../src/host/channels/channelManager');
  const { TelegramChannel } = await import('../../../src/host/channels/telegram/telegramChannel');
  class FakeTelegramChannel extends TelegramChannel {
    override get telegramCanReadAllGroupMessages() { return false; }
    override async initialize(_config: ChannelAccountConfig) {}
    override async connect() {}
    override async destroy() {}
  }
  const manager = ChannelManager.getInstance();
  const factory = vi.fn((id: string) => new FakeTelegramChannel(id));
  manager.registerPlugin({ type: 'telegram', meta: new FakeTelegramChannel('meta').meta, factory });
  state.manager = manager;
  const { registerChannelHandlers } = await import('../../../src/host/ipc/channel.ipc');
  const handlers = new Map<string, (event: unknown, id: string) => Promise<unknown>>();
  registerChannelHandlers({ handle: (name: string, handler: never) => handlers.set(name, handler) } as never, () => null);
  return {
    manager, factory,
    invoke: (channel: string, id: string) => handlers.get(channel)!({}, id),
  };
}

const persistedAccount: ChannelAccount = {
  id: 'telegram-restart', name: 'Restart bot', type: 'telegram',
  config: { type: 'telegram', botToken: 'fake-token', groupAccessMode: 'all_members' },
  status: 'connected', enabled: true, createdAt: 1,
  telegramCanReadAllGroupMessages: false,
};
const stored = () => JSON.parse(state.data.get('channel.accounts')!) as ChannelAccount[];

describe('ChannelManager persisted connection state', () => {
  beforeEach(() => { state.data.clear(); state.set.mockClear(); });
  afterEach(async () => { await state.manager?.shutdown(); });

  it('user Disconnect survives loadAccounts + connectAllEnabled with no privacy-warning connection; user Connect restores enabled', async () => {
    const first = await freshManager();
    const account = await first.manager.addAccount('Restart bot', 'telegram', persistedAccount.config);
    await expect(first.invoke(CHANNEL_CHANNELS.CONNECT_ACCOUNT, account.id)).resolves.toEqual({ success: true });
    expect(first.manager.getAccount(account.id)).toMatchObject({ status: 'connected', telegramCanReadAllGroupMessages: false });
    await expect(first.invoke(CHANNEL_CHANNELS.DISCONNECT_ACCOUNT, account.id)).resolves.toEqual({ success: true });
    expect(stored()[0]).toMatchObject({ enabled: false, status: 'disconnected' });
    const next = await freshManager();
    await next.manager.loadAccounts();
    await next.manager.connectAllEnabled();
    expect(next.manager.getAccount(account.id)).toMatchObject({ enabled: false, status: 'disconnected', telegramCanReadAllGroupMessages: false });
    expect(next.factory).not.toHaveBeenCalled();
    expect(first.factory).toHaveBeenCalledTimes(1);
    await expect(next.invoke(CHANNEL_CHANNELS.CONNECT_ACCOUNT, account.id)).resolves.toEqual({ success: true });
    expect(stored()[0]).toMatchObject({ enabled: true, status: 'connected', telegramCanReadAllGroupMessages: false });
    expect(next.factory).toHaveBeenCalledTimes(1);
  });

  it.each(['connected', 'connecting'] as const)('kill -9 persisted %s loads disconnected before any connect without writing storage', async (status) => {
    state.data.set('channel.accounts', JSON.stringify([{ ...persistedAccount, status, errorMessage: 'stale connection message' }]));
    const { manager, factory } = await freshManager();
    await manager.loadAccounts();
    expect(manager.getAccount(persistedAccount.id)).toMatchObject({ status: 'disconnected', enabled: true, telegramCanReadAllGroupMessages: false });
    expect(manager.getAccount(persistedAccount.id)?.errorMessage).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
    expect(stored()[0].status).toBe(status);
  });

  it('loadAccounts preserves error status and its message', async () => {
    state.data.set('channel.accounts', JSON.stringify([{ ...persistedAccount, status: 'error', errorMessage: 'retained error' }]));
    const { manager } = await freshManager();
    await manager.loadAccounts();
    expect(manager.getAccount(persistedAccount.id)).toMatchObject({ status: 'error', errorMessage: 'retained error' });
    expect(state.set).not.toHaveBeenCalled();
  });

  it('app quit disconnectAll leaves enabled true and reconnects on next start', async () => {
    const first = await freshManager();
    const account = await first.manager.addAccount('Restart bot', 'telegram', persistedAccount.config);
    await first.manager.connectAccount(account.id);
    await first.manager.disconnectAll();
    expect(first.manager.getAccount(account.id)).toMatchObject({ status: 'disconnected', enabled: true });
    expect(stored()[0].enabled).toBe(true);
    const next = await freshManager();
    await next.manager.loadAccounts();
    expect(next.manager.getAccount(account.id)?.status).toBe('disconnected');
    await next.manager.connectAllEnabled();
    expect(next.manager.getAccount(account.id)).toMatchObject({ status: 'connected', enabled: true, telegramCanReadAllGroupMessages: false });
    expect(next.factory).toHaveBeenCalledTimes(1);
  });
});
