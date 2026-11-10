// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, on: vi.fn(() => () => {}), invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/components/features/settings/sections/CompanionSection', () => ({
  CompanionSection: () => null,
}));

import { FeishuLastInboundLine } from '../../../src/renderer/components/features/settings/tabs/FeishuLastInboundLine';
import { ChannelsSettings } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { formatDateTime } from '../../../src/renderer/utils/formatDateTime';
import type { ChannelAccount } from '../../../src/shared/contract/channel';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const RECEIVED_AT = new Date(2026, 10, 8, 14, 32).getTime();

beforeEach(() => {
  invoke.mockReset();
  useAppStore.setState({ language: 'zh' });
});
afterEach(cleanup);

function account(options: { type?: ChannelAccount['type']; status?: ChannelAccount['status']; lastInboundAt?: number } = {}): ChannelAccount {
  const type = options.type ?? 'feishu';
  return {
    id: 'feishu-1', name: '飞书研发群', type, status: options.status ?? 'connected', enabled: true, createdAt: 1,
    config: type === 'telegram'
      ? { type: 'telegram', botToken: '123:abc' }
      : { type: 'feishu', appId: 'cli_123', appSecret: 'sec', useWebSocket: true },
    ...(options.lastInboundAt === undefined ? {} : { lastInboundAt: options.lastInboundAt }),
  };
}

describe('FeishuLastInboundLine', () => {
  it('zh: shows "尚未收到消息" without a time and the formatted time with one', () => {
    const { rerender } = render(<FeishuLastInboundLine account={account()} />);
    expect(screen.getByTestId('feishu-last-inbound').textContent).toBe(zh.settings.channels.modal.feishuNoInboundYet);
    expect(screen.getByTestId('feishu-last-inbound').textContent).toBe('尚未收到消息');
    rerender(<FeishuLastInboundLine account={account({ lastInboundAt: RECEIVED_AT })} />);
    expect(screen.getByTestId('feishu-last-inbound').textContent).toBe('最近收到消息 2026/11/08 14:32');
  });

  it('en: shows "No messages received yet" without a time and the formatted time with one', () => {
    useAppStore.setState({ language: 'en' });
    const { rerender } = render(<FeishuLastInboundLine account={account({ type: 'lark' })} />);
    expect(screen.getByTestId('feishu-last-inbound').textContent).toBe(en.settings.channels.modal.feishuNoInboundYet);
    rerender(<FeishuLastInboundLine account={account({ type: 'lark', lastInboundAt: RECEIVED_AT })} />);
    expect(screen.getByTestId('feishu-last-inbound').textContent)
      .toBe(`Last message received ${formatDateTime(RECEIVED_AT, 'en')}`);
  });

  it('renders nothing for telegram or when not connected', () => {
    const { rerender } = render(<FeishuLastInboundLine account={account({ type: 'telegram' })} />);
    expect(screen.queryByTestId('feishu-last-inbound')).toBeNull();
    for (const status of ['disconnected', 'connecting', 'error'] as const) {
      rerender(<FeishuLastInboundLine account={account({ status, lastInboundAt: RECEIVED_AT })} />);
      expect(screen.queryByTestId('feishu-last-inbound')).toBeNull();
    }
  });

  it('sits inside the status cell of the ChannelsSettings row', async () => {
    const accounts = [account({ lastInboundAt: RECEIVED_AT })];
    invoke.mockImplementation(async (channel: string) =>
      String(channel).toLowerCase().includes('types') ? [{ type: 'feishu', name: '飞书' }] : accounts,
    );
    render(<ChannelsSettings />);
    await screen.findByText('飞书研发群');
    const row = screen.getByText('飞书研发群').closest('[data-testid="channel-account-row"]') as HTMLElement;
    const cell = within(row).getByTestId('channel-account-status');
    expect(within(cell).getByTestId('feishu-last-inbound').textContent).toContain('最近收到消息');
  });
});
