import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelManager } from '../../../src/host/channels/channelManager';
import { FeishuChannel } from '../../../src/host/channels/feishu/feishuChannel';
import { FEISHU_LAST_INBOUND_PUSH_INTERVAL_MS } from '../../../src/shared/constants';
import type { ChannelAccount } from '../../../src/shared/contract/channel';

type WsStartOpts = { onReady?: () => void; eventDispatcher?: { handles: Map<string, (data: unknown) => Promise<unknown>> } };

const wsCaptures = vi.hoisted(() => ({ start: [] as WsStartOpts[] }));
const logLines = vi.hoisted(() => [] as string[]);
const store = vi.hoisted(() => new Map<string, string>());

vi.mock('../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => ({
    get: (key: string) => store.get(key),
    set: (key: string, value: string) => { store.set(key, value); },
    delete: (key: string) => { store.delete(key); },
  }),
}));

vi.mock('../../../src/host/services/infra/logger', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/infra/logger')>(
    '../../../src/host/services/infra/logger',
  );
  return {
    ...actual,
    createLogger: (context: string, options?: Parameters<typeof actual.createLogger>[1]) => {
      const created = actual.createLogger(context, options);
      if (context === 'FeishuChannel') {
        const originalInfo = created.info.bind(created);
        created.info = ((message: string, ...args: unknown[]) => {
          logLines.push(message);
          originalInfo(message, ...args);
        }) as typeof created.info;
      }
      return created;
    },
  };
});

vi.mock('@larksuiteoapi/node-sdk', async () => {
  const actual = await vi.importActual<typeof import('@larksuiteoapi/node-sdk')>('@larksuiteoapi/node-sdk');
  class WSClient {
    close = vi.fn();
    start = vi.fn(async (opts: WsStartOpts) => {
      wsCaptures.start.push(opts);
      opts.onReady?.();
    });
  }
  return { ...actual, WSClient };
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function messageBody(options: { eventId: string; messageId: string; senderType?: string }) {
  return {
    schema: '2.0',
    header: { event_id: options.eventId, event_type: 'im.message.receive_v1' },
    event: {
      message: {
        message_id: options.messageId,
        create_time: '1800000000000',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
      sender: { sender_id: { open_id: 'ou_sender', user_id: 'sender' }, sender_type: options.senderType ?? 'user' },
    },
  };
}

describe('Feishu last inbound time', () => {
  const createdIds: string[] = [];

  beforeEach(() => {
    wsCaptures.start.length = 0;
    logLines.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    const manager = ChannelManager.getInstance();
    for (const id of createdIds.splice(0)) {
      await manager.disconnectAccount(id);
      await manager.deleteAccount(id);
    }
  });

  async function webhookAccount(): Promise<{ account: ChannelAccount; url: string; manager: ChannelManager }> {
    const port = await freePort();
    const manager = ChannelManager.getInstance();
    const account = await manager.addAccount('Feishu Webhook', 'feishu', {
      type: 'feishu', appId: 'cli_last_inbound_webhook', appSecret: 'secret',
      verificationToken: 'verify', webhookPort: port, webhookHost: '127.0.0.1',
    });
    createdIds.push(account.id);
    await manager.connectAccount(account.id);
    return { account, url: `http://127.0.0.1:${port}/webhook/feishu`, manager };
  }

  const post = (url: string, body: unknown) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('① webhook route: connected account has no time until an event arrives, then carries it and pushes accounts_changed', async () => {
    const { account, url, manager } = await webhookAccount();
    expect(manager.getAccount(account.id)?.status).toBe('connected');
    expect(manager.getAccount(account.id)?.lastInboundAt).toBeUndefined();

    const pushed: Array<number | undefined> = [];
    const onChanged = (accounts: ChannelAccount[]) => pushed.push(accounts.find((a) => a.id === account.id)?.lastInboundAt);
    manager.on('accounts_changed', onChanged);
    try {
      const before = Date.now();
      expect((await post(url, messageBody({ eventId: 'e1', messageId: 'om_1' }))).status).toBe(200);
      const at = manager.getAccount(account.id)?.lastInboundAt;
      expect(at).toBeGreaterThanOrEqual(before);
      expect(pushed).toEqual([at]);
    } finally {
      manager.off('accounts_changed', onChanged);
    }
  });

  it('② filtered messages (bot sender, duplicate message_id, unpaired sender) still update the time, next to their drop-reason log', async () => {
    const { account, url, manager } = await webhookAccount();
    vi.useFakeTimers({ toFake: ['Date'] });
    const seen = () => manager.getAccount(account.id)?.lastInboundAt;

    vi.setSystemTime(1_800_000_001_000);
    await post(url, messageBody({ eventId: 'e-bot', messageId: 'om_bot', senderType: 'bot' }));
    expect(seen()).toBe(1_800_000_001_000);
    expect(logLines).toContain('Ignoring bot message to prevent loop');

    vi.setSystemTime(1_800_000_002_000);
    await post(url, messageBody({ eventId: 'e-unpaired', messageId: 'om_unpaired' }));
    expect(logLines).toContain('[feishu-ingress] denied');
    // 更新由 manager 节流（60s 内不推），但 channel 自身 getter 每条都更新
    const channel = (manager as unknown as { activeChannels: Map<string, FeishuChannel> }).activeChannels.get(account.id);
    expect(channel?.lastInboundAt).toBe(1_800_000_002_000);

    vi.setSystemTime(1_800_000_003_000);
    await post(url, messageBody({ eventId: 'e-dup', messageId: 'om_unpaired' }));
    expect(channel?.lastInboundAt).toBe(1_800_000_003_000);
    expect(logLines).toContain('Ignoring duplicate inbound message');

    vi.setSystemTime(1_800_000_003_000 + FEISHU_LAST_INBOUND_PUSH_INTERVAL_MS);
    await post(url, messageBody({ eventId: 'e-later', messageId: 'om_later', senderType: 'bot' }));
    expect(seen()).toBe(1_800_000_003_000 + FEISHU_LAST_INBOUND_PUSH_INTERVAL_MS);
  });

  it('③ WebSocket path: onEvent wiring records the time too', async () => {
    const manager = ChannelManager.getInstance();
    const account = await manager.addAccount('Feishu WS', 'feishu', {
      type: 'feishu', appId: 'cli_last_inbound_ws', appSecret: 'secret', useWebSocket: true,
    });
    createdIds.push(account.id);
    await manager.connectAccount(account.id);
    expect(manager.getAccount(account.id)?.lastInboundAt).toBeUndefined();

    const handler = wsCaptures.start.at(-1)?.eventDispatcher?.handles.get('im.message.receive_v1');
    expect(handler).toBeDefined();
    const body = messageBody({ eventId: 'ws1', messageId: 'om_ws', senderType: 'bot' });
    await handler!(body.event);
    expect(manager.getAccount(account.id)?.lastInboundAt).toBeGreaterThan(0);
  });

  it('trailing push: a throttled event is pushed at the 60 s mark, and a pending push dies with disconnect', async () => {
    const { account, url, manager } = await webhookAccount();
    const pushed: Array<number | undefined> = [];
    const onChanged = (accounts: ChannelAccount[]) => pushed.push(accounts.find((a) => a.id === account.id)?.lastInboundAt);
    manager.on('accounts_changed', onChanged);
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(1_800_000_000_000);
      await post(url, messageBody({ eventId: 't1', messageId: 'om_t1' }));
      expect(pushed).toEqual([1_800_000_000_000]);

      vi.setSystemTime(1_800_000_030_000);
      await post(url, messageBody({ eventId: 't2', messageId: 'om_t2' }));
      expect(pushed).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(FEISHU_LAST_INBOUND_PUSH_INTERVAL_MS - 30_000);
      expect(pushed).toHaveLength(2);
      expect(pushed[1]).toBe(1_800_000_030_000);

      // 再来一条被节流 -> 挂起定时器；断开后不得再推
      vi.setSystemTime(1_800_000_070_000);
      await post(url, messageBody({ eventId: 't3', messageId: 'om_t3' }));
      expect(pushed).toHaveLength(2);
      await manager.disconnectAccount(account.id);
      const afterDisconnect = pushed.length;
      await vi.advanceTimersByTimeAsync(FEISHU_LAST_INBOUND_PUSH_INTERVAL_MS * 2);
      expect(pushed).toHaveLength(afterDisconnect);
    } finally {
      manager.off('accounts_changed', onChanged);
    }
  });

  it('is runtime-only: stripped on save/load and cleared when disconnected', async () => {
    const { account, url, manager } = await webhookAccount();
    await post(url, messageBody({ eventId: 'e-save', messageId: 'om_save' }));
    expect(manager.getAccount(account.id)?.lastInboundAt).toBeDefined();

    // 触发一次真实 saveAccounts（改名走 updateAccount），落盘内容不得含运行时字段
    await manager.updateAccount(account.id, { name: 'Feishu Webhook renamed' });
    const persisted = [...store.values()].join('\n');
    expect(persisted).toContain('Feishu Webhook renamed');
    expect(persisted).not.toContain('lastInboundAt');
    // 带运行时字段的旧数据加载时也被剥掉
    const key = [...store.keys()][0];
    const rows = JSON.parse(store.get(key)!) as ChannelAccount[];
    store.set(key, JSON.stringify(rows.map((row) => ({ ...row, lastInboundAt: 123 }))));
    await manager.loadAccounts();
    expect(manager.getAccount(account.id)?.lastInboundAt).toBeUndefined();

    await manager.disconnectAccount(account.id);
    expect(manager.getAccount(account.id)?.lastInboundAt).toBeUndefined();
  });
});
