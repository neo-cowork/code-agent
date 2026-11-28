// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const invokeDomain = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: vi.fn(() => vi.fn()) },
}));

import { KeybindingsSettings } from '../../../src/renderer/components/features/settings/tabs/KeybindingsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';

const HAN = /[㐀-䶿一-鿿豈-﫿]/u;

beforeEach(() => {
  invokeDomain.mockReset();
  invokeDomain.mockResolvedValue(undefined);
  useBundledCapabilityStore.setState({ installed: { 'builtin.voice-live': true, 'builtin.voice-input': true } });
});
afterEach(cleanup);

describe('快捷键页未绑定项的「未设置」跟随界面语言（FB-1293）', () => {
  it('英文界面显示 Not set，整页没有中文', async () => {
    useAppStore.setState({ language: 'en' });
    const { container } = render(<KeybindingsSettings />);
    await waitFor(() => expect(container.textContent).toContain('Default: Not set'));
    expect(container.textContent).not.toMatch(HAN);
  });

  it('中文界面仍是「未设置」', async () => {
    useAppStore.setState({ language: 'zh' });
    const { container } = render(<KeybindingsSettings />);
    await waitFor(() => expect(container.textContent).toContain('未设置'));
    expect(container.textContent).not.toContain('Not set');
  });
});
