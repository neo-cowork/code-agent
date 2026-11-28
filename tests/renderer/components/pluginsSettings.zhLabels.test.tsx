// @vitest-environment jsdom
// 中文插件卡行标签翻译 + Trust 行不再「标签+前缀」叠加
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';
import { SKILL_REGISTRY_MARKETPLACE_ID } from '../../../src/shared/contract/skillRegistry';
import { en } from '../../../src/renderer/i18n/en';

const invoke = vi.hoisted(() => vi.fn());
// 可切换 zh/en 的 useI18n mock（默认 zh，保持既有用例行为）
const i18nState = vi.hoisted(() => ({ t: null as unknown, language: 'zh' as string }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: i18nState.t, language: i18nState.language }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke },
}));

import { PluginsSettings } from '../../../src/renderer/components/features/settings/tabs/PluginsSettings';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

const INSTALLED = {
  name: 'label-plugin',
  marketplace: SKILL_REGISTRY_MARKETPLACE_ID,
  scope: 'user',
  isEnabled: true,
  installedAt: '2026-01-01',
  skills: ['skills/a'],
  commands: ['commands/b'],
  pluginRoot: '/opt/plugins/label-plugin',
  types: ['skill', 'command'],
};
const ENTRY = { name: 'market-plugin', marketplace: SKILL_REGISTRY_MARKETPLACE_ID, source: './m', skills: ['s'] };

beforeEach(() => {
  i18nState.t = zh;
  i18nState.language = 'zh';
});

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
    await screen.findByText(`label-plugin@${SKILL_REGISTRY_MARKETPLACE_ID}`);
    await screen.findByText(`market-plugin@${SKILL_REGISTRY_MARKETPLACE_ID}`);
    const text = container.textContent ?? '';
    expect(text).not.toContain('Trust');
    const t = zh.settings.plugins.installed;
    expect(text.split(t.trust).length - 1).toBe(2); // 已装卡 + 市场卡各一次
    // 已装卡头部 pill：中文标签，且不残留独立的 official/user/skill/command pill
    const header = screen.getByRole('heading', { name: 'label-plugin' }).parentElement!;
    const pillTexts = Array.from(header.querySelectorAll('span.rounded-md.border')).map((el) => el.textContent);
    for (const zhPill of ['官方', '用户级', '技能', '命令']) expect(pillTexts).toContain(zhPill);
    for (const raw of ['official', SKILL_REGISTRY_MARKETPLACE_ID, 'user', 'skill', 'command']) expect(pillTexts).not.toContain(raw);
    // 「可见插件」列表里的 scope pill 同样中文化
    expect(container.textContent).not.toMatch(/(^|[^a-z])user($|[^a-z])/);
    for (const label of [t.runtime, t.skills, t.commands, t.pluginAsset]) expect(text).toContain(label);
  });

  it('用户自建且恰好叫 official 的 marketplace 保持原名，不被误译成「官方」', async () => {
    useAuthStore.setState({ user: { id: 'admin', email: 'a@example.com', isAdmin: true } });
    const custom = { ...INSTALLED, name: 'custom-plugin', marketplace: 'official' };
    invoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED) return Promise.resolve({ success: true, data: [custom] });
      if (channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS || channel === IPC_CHANNELS.MARKETPLACE_LIST || channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) return Promise.resolve({ status: 'fallback' });
      throw new Error(`Unexpected channel ${channel}`);
    });
    render(<PluginsSettings />);
    const header = (await screen.findByRole('heading', { name: 'custom-plugin' })).parentElement!;
    const pills = Array.from(header.querySelectorAll('span.rounded-md.border')).map((el) => el.textContent);
    expect(pills).toContain('official');
    expect(pills).not.toContain('官方');
  });
});

// Marketplace 源行 pill：数量带单复数、autoUpdate 条件渲染（N-FIX-ZH-UI-PLUGIN-MARKETPLACE-SOURCE-ENGLISH-PILLS）
const MARKETPLACE_SOURCES = [
  {
    name: 'alpha-market',
    source: { source: 'directory', path: '/marketplaces/alpha' },
    installLocation: '/marketplaces/alpha',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    pluginCount: 1,
    autoUpdate: true,
  },
  {
    name: 'beta-market',
    source: { source: 'directory', path: '/marketplaces/beta' },
    installLocation: '/marketplaces/beta',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    pluginCount: 2,
    autoUpdate: false,
  },
  {
    name: 'gamma-market',
    source: { source: 'directory', path: '/marketplaces/gamma' },
    installLocation: '/marketplaces/gamma',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    pluginCount: 0,
  },
];

function mockMarketplaceChannels() {
  invoke.mockImplementation((channel: string) => {
    if (channel === IPC_CHANNELS.MARKETPLACE_LIST) {
      return Promise.resolve({ success: true, data: MARKETPLACE_SOURCES });
    }
    if (channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED
      || channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS
      || channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST) {
      return Promise.resolve({ success: true, data: [] });
    }
    if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) return Promise.resolve({ status: 'fallback' });
    throw new Error(`Unexpected channel ${channel}`);
  });
}

/** 展开默认收起的 Marketplace 源管理 <details>（管理员可见），返回其根节点 */
function openMarketplaceSourcesDetails(): HTMLElement {
  const root = screen.getByTestId('marketplace-source-management');
  const details = root.querySelector('details');
  expect(details).toBeTruthy();
  expect((details as HTMLDetailsElement).open).toBe(false);
  (details as HTMLDetailsElement).open = true;
  return root;
}

describe('PluginsSettings Marketplace 源行 pill 文案', () => {
  it('目录词条：zh pluginCount one=other，en one≠other', () => {
    expect(zh.settings.plugins.marketplaceSources.pluginCount.one)
      .toBe(zh.settings.plugins.marketplaceSources.pluginCount.other);
    expect(en.settings.plugins.marketplaceSources.pluginCount.one)
      .not.toBe(en.settings.plugins.marketplaceSources.pluginCount.other);
  });

  it('zh：源行显示「N 个插件」，仅 autoUpdate 为真的源出现「自动更新」', async () => {
    useAuthStore.setState({ user: { id: 'admin', email: 'a@example.com', isAdmin: true } });
    mockMarketplaceChannels();
    const { container } = render(<PluginsSettings />);
    openMarketplaceSourcesDetails();
    await screen.findByText('1 个插件');
    expect(screen.getByText('2 个插件')).toBeTruthy();
    expect(screen.getByText('0 个插件')).toBeTruthy();
    expect(screen.getByText('自动更新')).toBeTruthy();
    // beta（autoUpdate:false）与 gamma（未设置）都不渲染自动更新 pill
    expect((container.textContent ?? '').split('自动更新').length - 1).toBe(1);
    expect(container.textContent).not.toContain('auto update');
    expect(container.textContent).not.toMatch(/\d plugins/);
  });

  it('en：源行单复数 1 plugin / 2 plugins / 0 plugins 与 auto update', async () => {
    i18nState.t = en;
    i18nState.language = 'en';
    useAuthStore.setState({ user: { id: 'admin', email: 'a@example.com', isAdmin: true } });
    mockMarketplaceChannels();
    const { container } = render(<PluginsSettings />);
    openMarketplaceSourcesDetails();
    await screen.findByText('1 plugin');
    expect(screen.getByText('2 plugins')).toBeTruthy();
    expect(screen.getByText('0 plugins')).toBeTruthy();
    expect(screen.getByText('auto update')).toBeTruthy();
    expect((container.textContent ?? '').split('auto update').length - 1).toBe(1);
    expect(container.textContent).not.toContain('个插件');
    expect(container.textContent).not.toContain('自动更新');
  });
});

describe('PluginsSettings Pill 无裸英文源码门', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../..');
  const SCAN_FILES = [
    'src/renderer/components/features/settings/tabs/PluginsSettings.tsx',
    'src/renderer/components/features/settings/tabs/PluginsSettings.ui.tsx',
  ];

  it('<Pill> 的 JSX 文本不得含未走 i18n 的英文字面量', () => {
    const offenders: string[] = [];
    for (const rel of SCAN_FILES) {
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      for (const match of source.matchAll(/<Pill\b[^>]*>([\s\S]*?)<\/Pill>/g)) {
        const literalText = match[1].replace(/\{[^{}]*\}/g, '');
        const word = literalText.match(/[A-Za-z]{2,}/);
        if (word) offenders.push(`${rel}: “${word[0]}” in ${match[0].replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    expect(offenders, `Pill 里出现未 i18n 的英文字面量:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('PluginsSettings 中文文案无中英混杂', () => {
  it('zh.settings.plugins 与 searchIndex.marketplaceSource 字符串叶节点不残留英文术语或能力包', () => {
    const offenders: string[] = [];
    const skippedPaths = new Set(['plugins.marketplaceSources.placeholder']);
    const walkLeaves = (node: unknown, keyPath: string): void => {
      if (skippedPaths.has(keyPath) || /^plugins\.completeness\.rows\[\d+\]\.status$/.test(keyPath)) {
        return;
      }
      if (typeof node === 'string') {
        if (node.includes('能力包')) {
          offenders.push(`${keyPath}: forbidden term 能力包 (${JSON.stringify(node)})`);
        }
        const stripped = node
          .replace(/\{[A-Za-z_]\w*\}/g, '')
          .replace(/(?<![A-Za-z])(Neo|GitHub|npm)(?![A-Za-z])/g, '');
        const words = stripped.match(/[A-Za-z]{2,}/g);
        if (words) {
          offenders.push(`${keyPath}: ${words.join(', ')} (${JSON.stringify(node)})`);
        }
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item, idx) => walkLeaves(item, `${keyPath}[${idx}]`));
        return;
      }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          walkLeaves(value, `${keyPath}.${key}`);
        }
      }
    };

    walkLeaves(zh.settings.plugins, 'plugins');
    walkLeaves(zh.settings.searchIndex.marketplaceSource, 'searchIndex.marketplaceSource');

    expect(offenders, `zh 插件文案仍残留英文术语:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('空目录渲染 PluginsSettings（zh/admin）时，空态文案、搜索框占位符与两个下拉框 aria-label 均不含英文术语', async () => {
    useAuthStore.setState({ user: { id: 'admin', email: 'a@example.com', isAdmin: true } });
    invoke.mockImplementation((channel: string) => {
      if (
        channel === IPC_CHANNELS.MARKETPLACE_LIST
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS
        || channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST
      ) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) {
        return Promise.resolve({ status: 'fallback' });
      }
      throw new Error(`Unexpected channel ${channel}`);
    });

    const { container } = render(<PluginsSettings />);
    await screen.findByText(zh.settings.plugins.installed.empty);

    const forbidden = /marketplace|skill|command|scope/i;
    const emptyCatalogEl = screen.getByText(zh.settings.plugins.marketplace.emptyCatalog);
    expect(emptyCatalogEl.textContent ?? '').not.toMatch(forbidden);

    const searchInput = container.querySelector('input[type="search"]') as HTMLInputElement | null;
    expect(searchInput).toBeTruthy();
    expect(searchInput?.placeholder ?? '').not.toMatch(forbidden);

    const selects = Array.from(container.querySelectorAll('select'));
    expect(selects).toHaveLength(2);
    for (const select of selects) {
      const ariaLabel = select.getAttribute('aria-label') ?? '';
      expect(ariaLabel.length).toBeGreaterThan(0);
      expect(ariaLabel).not.toMatch(forbidden);
    }
  });
});
