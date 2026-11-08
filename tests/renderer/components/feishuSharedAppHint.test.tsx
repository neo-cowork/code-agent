// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webMode = vi.hoisted(() => ({ value: false }));
const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke,
    on: vi.fn(() => () => {}),
    invokeDomain: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/utils/platform')>()),
  isWebMode: () => webMode.value,
}));
vi.mock('../../../src/renderer/components/features/settings/sections/CompanionSection', () => ({
  CompanionSection: () => null,
}));

import { FeishuSharedAppHint } from '../../../src/renderer/components/features/settings/tabs/FeishuSharedAppHint';
import { ChannelsSettings } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import type { ChannelAccount } from '../../../src/shared/contract/channel';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const ZH_WARNING = zh.settings.channels.modal.feishuSharedAppWarning;
const EN_WARNING = en.settings.channels.modal.feishuSharedAppWarning;

beforeEach(() => {
  webMode.value = false;
  invoke.mockReset();
});

afterEach(cleanup);

function feishuAccount(options: {
  type?: ChannelAccount['type'];
  status?: ChannelAccount['status'];
  feishuSharedAppDetected?: boolean;
} = {}): ChannelAccount {
  const type = options.type ?? 'feishu';
  return {
    id: 'feishu-1',
    name: '飞书研发群',
    type,
    status: options.status ?? 'connected',
    enabled: true,
    createdAt: 1,
    config: type === 'telegram'
      ? { type: 'telegram', botToken: '123:abc' }
      : { type: 'feishu', appId: 'cli_123', appSecret: 'sec', useWebSocket: true },
    ...(options.feishuSharedAppDetected === undefined
      ? {}
      : { feishuSharedAppDetected: options.feishuSharedAppDetected }),
  };
}

describe('FeishuSharedAppHint', () => {
  it('defines non-empty zh and en warning strings', () => {
    expect(ZH_WARNING).toContain('本机还有另一个 Neo 也连着这个飞书应用');
    expect(EN_WARNING).toContain('Another Neo on this computer is also connected to this Feishu app');
  });

  it('shows the warning when status === connected and feishuSharedAppDetected is true', () => {
    render(<FeishuSharedAppHint account={feishuAccount({ status: 'connected', feishuSharedAppDetected: true })} />);
    expect(screen.getByTestId('feishu-shared-app-hint').textContent).toBe(ZH_WARNING);
  });

  it('hides the hint when feishuSharedAppDetected is false or undefined', () => {
    const { rerender } = render(
      <FeishuSharedAppHint account={feishuAccount({ status: 'connected', feishuSharedAppDetected: false })} />,
    );
    expect(screen.queryByTestId('feishu-shared-app-hint')).toBeNull();
    rerender(<FeishuSharedAppHint account={feishuAccount({ status: 'connected' })} />);
    expect(screen.queryByTestId('feishu-shared-app-hint')).toBeNull();
  });

  it.each([['disconnected'], ['error'], ['connecting']] as const)(
    'hides the hint when status is %s even if feishuSharedAppDetected is true',
    (status) => {
      render(<FeishuSharedAppHint account={feishuAccount({ status, feishuSharedAppDetected: true })} />);
      expect(screen.queryByTestId('feishu-shared-app-hint')).toBeNull();
    },
  );

  it('hides the hint for non-Feishu/Lark channel types', () => {
    render(
      <FeishuSharedAppHint
        account={feishuAccount({ type: 'telegram', status: 'connected', feishuSharedAppDetected: true })}
      />,
    );
    expect(screen.queryByTestId('feishu-shared-app-hint')).toBeNull();
  });

  it('renders FeishuSharedAppHint inside the ChannelsSettings Feishu row when connected with flag', async () => {
    const accounts = [feishuAccount({ status: 'connected', feishuSharedAppDetected: true })];
    const types = [{ type: 'feishu', name: '飞书' }];
    invoke.mockImplementation(async (channel: string) =>
      String(channel).toLowerCase().includes('types') ? types : accounts,
    );

    render(<ChannelsSettings />);
    await screen.findByText('飞书研发群');
    const row = screen.getByText('飞书研发群').closest('div.grid') as HTMLElement;
    expect(within(row).getByTestId('feishu-shared-app-hint').textContent).toBe(ZH_WARNING);
  });
});
