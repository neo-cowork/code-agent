// @vitest-environment jsdom
// 中文插件卡行标签翻译 + Trust 行不再「标签+前缀」叠加
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke },
}));

import { PluginsSettings } from '../../../src/renderer/components/features/settings/tabs/PluginsSettings';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

const INSTALLED = {
  name: 'label-plugin',
  marketplace: 'official',
  scope: 'user',
  isEnabled: true,
  installedAt: '2026-01-01',
  skills: ['skills/a'],
  commands: ['commands/b'],
  pluginRoot: '/opt/plugins/label-plugin',
  types: ['skill', 'command'],
};
const ENTRY = { name: 'market-plugin', marketplace: 'official', source: './m', skills: ['s'] };

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
});

describe('PluginsSettings 中文行标签', () => {
  it('zh 行标签与 trustSummary 单位均不同于 en', () => {
    const z = zh.settings.plugins;
    const e = en.settings.plugins;
    for (const k of ['runtime', 'skills', 'commands', 'pluginAsset', 'trust'] as const) {
      expect(z.installed[k]).not.toBe(e.installed[k]);
    }
    for (const k of ['skillsUnit', 'commandsUnit', 'permissionsUnit', 'hooksUnit'] as const) {
      expect(z.trustSummary[k]).not.toBe(e.trustSummary[k]);
    }
    expect(z.runtimeLabels.adapterPending).not.toBe(e.runtimeLabels.adapterPending);
    expect(z.trustSummary.prefix).toBe('');
    expect(e.trustSummary.prefix).toBe('');
  });

  it('已装卡与市场卡的 Trust 行只出现一次「信任」，无 Trust', async () => {
    useAuthStore.setState({ user: { id: 'admin', email: 'a@example.com', isAdmin: true } });
    invoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED) return Promise.resolve({ success: true, data: [INSTALLED] });
      if (channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS) return Promise.resolve({ success: true, data: [ENTRY] });
      if (channel === IPC_CHANNELS.MARKETPLACE_LIST || channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) return Promise.resolve({ status: 'fallback' });
      throw new Error(`Unexpected channel ${channel}`);
    });
    const { container } = render(<PluginsSettings />);
    await screen.findByText('label-plugin@official');
    await screen.findByText('market-plugin@official');
    const text = container.textContent ?? '';
    expect(text).not.toContain('Trust');
    const t = zh.settings.plugins.installed;
    expect(text.split(t.trust).length - 1).toBe(2); // 已装卡 + 市场卡各一次
    // 已装卡头部 pill：中文标签，且不残留独立的 official/user/skill/command pill
    const header = screen.getByRole('heading', { name: 'label-plugin' }).parentElement!;
    const pillTexts = Array.from(header.querySelectorAll('span.rounded-md.border')).map((el) => el.textContent);
    for (const zhPill of ['官方', '用户级', '技能', '命令']) expect(pillTexts).toContain(zhPill);
    for (const raw of ['official', 'user', 'skill', 'command']) expect(pillTexts).not.toContain(raw);
    // 「可见插件」列表里的 scope pill 同样中文化
    expect(container.textContent).not.toMatch(/(^|[^a-z])user($|[^a-z])/);
    for (const label of [t.runtime, t.skills, t.commands, t.pluginAsset]) expect(text).toContain(label);
  });
});
