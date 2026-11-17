// @vitest-environment jsdom
// ============================================================================
// N-FIX-UI-EMPTY-VALUE-SETTINGS-SHOTS —— 空值整行不渲染（续 emptyValueNotShownAsNone）
//   插件卡：没有 skills / commands / pluginRoot 时不出「Skills 无」之类的空盒子
//   记忆导入回执：writtenFiles 为空时不出「写入文件：无」
// 走真实生产组件 PluginsSettings / MemoryTab，只 mock IPC 与语言。
// ============================================================================
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const state = vi.hoisted(() => ({ lang: 'zh' as 'zh' | 'en', writtenFiles: [] as string[] }));
const invoke = vi.hoisted(() => vi.fn());
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: state.lang === 'zh' ? zh : en, language: state.lang }) };
});
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke, invokeDomain },
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({ pickNativeFile: vi.fn() }));
vi.mock('../../../src/renderer/utils/platform', () => ({
  isTauriMode: () => false,
  isWebMode: () => true,
}));

import { PluginsSettings } from '../../../src/renderer/components/features/settings/tabs/PluginsSettings';
import { MemoryTab } from '../../../src/renderer/components/features/settings/tabs/MemoryTab';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

const emptyPlugin = {
  name: 'weekly-report-helper',
  marketplace: 'official',
  scope: 'user',
  isEnabled: true,
  installedAt: '2026-11-10T08:00:00.000Z',
  types: [],
  skills: [],
};

function installPluginIpc(plugin: Record<string, unknown>) {
  invoke.mockImplementation((channel: string) => {
    if (channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED) return Promise.resolve({ success: true, data: [plugin] });
    if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) return Promise.resolve({ status: 'fallback' });
    if (channel === IPC_CHANNELS.MARKETPLACE_LIST || channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS
      || channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST) {
      return Promise.resolve({ success: true, data: [] });
    }
    throw new Error(`Unexpected channel ${channel}`);
  });
}

const importBundle = {
  schemaVersion: 2,
  exportedAt: 1789000000000,
  entries: [],
  index: { path: 'INDEX.md', content: null },
  evidenceManifest: [],
  sourceCounts: { light_file: 0, db_memory: 1 },
};
const dryRun = {
  schemaVersion: 2, incomingCount: 1, existingCount: 0, added: 1, updated: 0, conflicted: 0, skipped: 0,
  items: [{ entryId: 'db:weekly-report-style', status: 'add', reason: 'new entry', incomingTitle: '周报写作偏好', sourceOfTruth: 'db_memory' }],
};

async function importAndApply() {
  invokeDomain.mockImplementation((_d: string, action: string) => {
    if (action === 'lightList') return Promise.resolve([]);
    if (action === 'memoryImportV2DryRun') return Promise.resolve(dryRun);
    if (action === 'memoryImportV2Apply') {
      return Promise.resolve({ ...dryRun, applied: 1, created: 1, updatedApplied: 0, skippedApply: 0, writtenFiles: state.writtenFiles });
    }
    return Promise.resolve(undefined);
  });
  render(<MemoryTab />);
  const input = await screen.findByTestId('memory-import-file-input');
  const file = new File([JSON.stringify(importBundle)], 'memory.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(JSON.stringify(importBundle)) });
  fireEvent.change(input, { target: { files: [file] } });
  const t = state.lang === 'zh' ? zh : en;
  const apply = await screen.findByRole('button', { name: t.settings.memory.import.apply });
  await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(apply);
  return screen.findByTestId('memory-import-receipt');
}

beforeEach(() => {
  state.lang = 'zh';
  state.writtenFiles = [];
  useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
  invoke.mockReset();
  invokeDomain.mockReset();
});

describe.each(['zh', 'en'] as const)('空值整行不渲染（%s）', (lang) => {
  const t = lang === 'zh' ? zh : en;

  it('插件卡：无 skills / commands / pluginRoot 时三个盒子都不渲染', async () => {
    state.lang = lang;
    installPluginIpc(emptyPlugin);
    render(<PluginsSettings />);
    await screen.findByText('weekly-report-helper');
    const installed = t.settings.plugins.installed;
    const text = document.body.textContent ?? '';
    expect(text).toContain(installed.runtime);
    expect(text).toContain(installed.trust);
    expect(text).not.toContain(installed.skills);
    expect(text).not.toContain(installed.commands);
    expect(text).not.toContain(installed.pluginAsset);
    expect(text).not.toMatch(new RegExp(`(${installed.skills}|${installed.commands}|${installed.pluginAsset})\\s*(无|None)`));
  });

  it('插件卡（对照）：有内容时三个盒子照常渲染', async () => {
    state.lang = lang;
    installPluginIpc({ ...emptyPlugin, skills: ['weekly-report'], commands: ['/report'], pluginRoot: '/tmp/weekly-report-helper' });
    render(<PluginsSettings />);
    await screen.findByText('weekly-report-helper');
    const text = document.body.textContent ?? '';
    expect(text).toContain(`${t.settings.plugins.installed.skills}weekly-report`);
    expect(text).toContain(`${t.settings.plugins.installed.commands}/report`);
    expect(text).toContain(t.settings.plugins.installed.pluginAsset);
  });

  it('记忆导入回执：writtenFiles 为空时没有「写入文件」行', async () => {
    state.lang = lang;
    const receipt = await importAndApply();
    expect(receipt.textContent).toContain(t.settings.memory.import.receiptPrefix);
    expect(receipt.textContent).not.toContain(t.settings.memory.import.writtenFilesPrefix.trim());
    expect(receipt.textContent).not.toMatch(/写入文件|Written files|[：:] ?(无|None)/);
  });

  it('记忆导入回执（对照）：有写入文件时「写入文件」行照常出现', async () => {
    state.lang = lang;
    state.writtenFiles = ['weekly_report_style.md'];
    const receipt = await importAndApply();
    expect(receipt.textContent).toContain(`${t.settings.memory.import.writtenFilesPrefix}weekly_report_style.md`);
  });
});
