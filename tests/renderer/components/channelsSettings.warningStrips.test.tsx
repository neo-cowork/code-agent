// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, on: vi.fn(() => () => {}), invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/utils/platform')>()),
  isWebMode: () => false,
}));
vi.mock('../../../src/renderer/components/features/settings/sections/CompanionSection', () => ({
  CompanionSection: () => null,
}));

import { ChannelsSettings } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { ChannelAccount } from '../../../src/shared/contract/channel';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const accounts: ChannelAccount[] = [
  {
    id: 'tg-warning',
    name: 'Telegram warning',
    type: 'telegram',
    status: 'connected',
    enabled: true,
    createdAt: 1,
    telegramCanReadAllGroupMessages: false,
    config: { type: 'telegram', botToken: '123:warning', groupAccessMode: 'all_members' },
  },
  {
    id: 'tg-ready',
    name: 'Telegram ready',
    type: 'telegram',
    status: 'connected',
    enabled: true,
    createdAt: 2,
    telegramCanReadAllGroupMessages: true,
    config: { type: 'telegram', botToken: '123:ready', groupAccessMode: 'all_members' },
  },
  {
    id: 'feishu-warning',
    name: 'Feishu warning',
    type: 'feishu',
    status: 'connected',
    enabled: true,
    createdAt: 3,
    config: { type: 'feishu', appId: 'app-id', appSecret: 'app-secret', useWebSocket: true },
  },
];
const types = [
  { type: 'telegram', name: 'Telegram' },
  { type: 'feishu', name: 'Feishu' },
];

function accountRow(name: string): HTMLElement {
  return screen.getByText(name).closest('[data-testid="channel-account-row"]') as HTMLElement;
}

beforeEach(() => {
  invoke.mockImplementation(async (channel: string) =>
    String(channel).toLowerCase().includes('types') ? types : accounts);
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  invoke.mockReset();
});

describe.each([['zh', zh], ['en', en]] as const)('ChannelsSettings warning strips (%s)', (language, locale) => {
  it('keeps full warning strips outside the status cell without truncating either locale', async () => {
    useAppStore.setState({ language });
    render(<ChannelsSettings />);
    await screen.findByText('Telegram warning');

    const warningRow = accountRow('Telegram warning');
    const readyRow = accountRow('Telegram ready');
    const statusCell = within(warningRow).getByTestId('channel-account-status');
    const hint = within(warningRow).getByTestId('telegram-privacy-mode-hint');
    const warningGrid = within(warningRow).getByTestId('channel-account-grid-row');
    const readyGrid = within(readyRow).getByTestId('channel-account-grid-row');

    expect(statusCell.contains(hint)).toBe(false);
    expect(warningGrid.contains(hint)).toBe(false);
    expect(within(statusCell).queryByText(locale.settings.channels.modal.telegramPrivacyModeWarning)).toBeNull();
    expect(within(statusCell).getByText(locale.settings.channels.modal.telegramPrivacyModeBadge)).toBeTruthy();
    expect(within(hint).getByText(locale.settings.channels.modal.telegramPrivacyModeTitle)).toBeTruthy();
    expect(within(hint).getByText(locale.settings.channels.modal.telegramPrivacyModeWarning).textContent).toBe(
      locale.settings.channels.modal.telegramPrivacyModeWarning,
    );
    expect(hint.getAttribute('role')).toBe('status');
    expect([hint, ...Array.from(hint.querySelectorAll('*'))].some((element) =>
      /(?:^|\s)(?:truncate|line-clamp-\S+)(?:\s|$)/.test(element.getAttribute('class') ?? ''))).toBe(false);

    expect(warningGrid.className).toBe(readyGrid.className);
    expect(warningGrid.children).toHaveLength(5);
    expect(readyGrid.children).toHaveLength(5);
    expect(within(readyRow).queryByTestId('telegram-privacy-mode-hint')).toBeNull();
    expect(within(readyRow).queryByText(locale.settings.channels.modal.telegramPrivacyModeBadge)).toBeNull();
  });

  it('renders the approval-card warning in the same strip outside the status cell', async () => {
    useAppStore.setState({ language });
    render(<ChannelsSettings />);
    await screen.findByText('Feishu warning');

    const row = accountRow('Feishu warning');
    const statusCell = within(row).getByTestId('channel-account-status');
    const body = within(row).getByText(locale.settings.channels.modal.approvalCardSecurityWarning);
    const strip = body.closest('[role="status"]') as HTMLElement;

    expect(strip).toBeTruthy();
    expect(statusCell.contains(strip)).toBe(false);
    expect(strip.closest('[data-testid="channel-account-warnings"]')).toBeTruthy();
    expect(strip.querySelector('svg')).toBeTruthy();
    expect(strip.className).not.toMatch(/truncate|line-clamp/);
  });
});
