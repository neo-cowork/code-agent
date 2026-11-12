// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const reason = 'Telegram 凭据或权限有误，请检查机器人令牌并确认访问权限后重新连接。';
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(async (channel: string) => channel.toLowerCase().includes('types')
      ? [{ type: 'telegram', name: 'Telegram' }]
      : [{ id: 'test-channel', name: '周报机器人', type: 'telegram', status: 'error', errorMessage: reason, enabled: true, createdAt: 1, config: { type: 'telegram', botToken: '123:example' } }]),
    on: vi.fn(() => () => {}),
    invokeDomain: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/components/features/settings/sections/CompanionSection', () => ({ CompanionSection: () => null }));
import { ChannelsSettings } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';

afterEach(cleanup);

describe('channel status reason', () => {
  it('renders the entire reason with wrapping and retains its hover text', async () => {
    render(<ChannelsSettings />);
    const error = await screen.findByText(reason);
    expect(error.closest('[data-testid="channel-account-status"]')).toBeTruthy();
    expect(error.getAttribute('title')).toBe(reason);
    expect(error.className).toContain('break-words');
    expect(error.className).toContain('whitespace-pre-wrap');
    expect(error.className).not.toContain('truncate');
  });
});
