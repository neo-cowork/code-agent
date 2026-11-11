// @vitest-environment jsdom
import React from 'react';
import fs from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProvider } from '../../../src/shared/contract';

const settings = vi.hoisted(() => ({ models: { routing: {}, providers: {
  deepseek: { enabled: true, apiKeyConfigured: true, model: 'deepseek-chat' },
  custom: { enabled: true, apiKeyConfigured: true, displayName: 'Custom Provider', model: 'custom-model' },
  claude: { enabled: true, apiKeyConfigured: true, protocol: 'claude', model: 'claude-sonnet-4-6' },
} } }));
vi.mock('../../../src/renderer/services/ipcService', () => {
  const invokeDomain = vi.fn(async (domain: string, action: string) => {
    if (domain.endsWith('settings') && action === 'get') return settings;
    if (action === 'listSources') return [];
    if (action === 'listModels') return { catalog: { engines: [] }, diagnostics: [] };
    if (action === 'listProviders') return { providers: [] };
    if (action === 'getManagedBrowserSession') return { running: false };
    if (action === 'getAllServiceKeys') return {};
    if (action === 'getStatus') return {};
    if (action.startsWith('list') || action.startsWith('getAll')) return [];
    return null;
  });
  return { invokeDomain, default: { invokeDomain,
  invoke: vi.fn(async () => null), on: vi.fn(() => () => {}), isAvailable: () => true,
} }; });
import { ModelSettings } from '../../../src/renderer/components/features/settings/tabs/ModelSettings';
import { ModelOnboardingModal } from '../../../src/renderer/components/onboarding/ModelOnboardingModal';
import { useAppStore } from '../../../src/renderer/stores/appStore';

import { SettingsModal, buildSettingsTabs } from '../../../src/renderer/components/features/settings/SettingsModal';
import { zh } from '../../../src/renderer/i18n/zh';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { useExternalImportStore } from '../../../src/renderer/stores/externalImportStore';

import { compareSettingsJargon, findSettingsJargon } from '../../../scripts/ci/check-settings-jargon.mjs';
import baseline from '../../../scripts/ci/settings-jargon-baseline.json';

const rows: { surface: string; text: string }[] = [];
function census(surface: string, root: HTMLElement) {
  // JSDOM has no layout-backed innerText. Keep node boundaries so adjacent
  // labels cannot concatenate Provider with a neighboring word and evade the gate.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: string[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode.textContent ?? '');
  const text = [...nodes, ...[root, ...Array.from(root.querySelectorAll('[title], [placeholder], [aria-label]'))]
    .flatMap((el) => ['title', 'placeholder', 'aria-label'].map((attr) => el.getAttribute(attr) ?? ''))].join('\n');
  rows.push({ surface, text });
  expect(compareSettingsJargon([{ surface, hits: findSettingsJargon(text) }], baseline.components)).toEqual([]);
}
beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  Element.prototype.scrollIntoView = vi.fn();
  useAppStore.setState({ language: 'zh', cloudUIStrings: null, settingsInitialTab: null, modelConfig: { provider: 'deepseek', model: 'deepseek-chat' } });
  useBundledCapabilityStore.setState({ installed: { 'builtin.voice-live': true, 'builtin.voice-input': true }, loaded: true });
  useExternalImportStore.setState({ status: 'available' });
});
afterEach(() => {
  cleanup();
  if (process.env.SETTINGS_CENSUS_OUT) fs.writeFileSync(process.env.SETTINGS_CENSUS_OUT, JSON.stringify(rows, null, 2));
});

describe('zh settings rendered text census (real components)', () => {
  const tabs = buildSettingsTabs({ t: zh, showScreenMemoryTab: true, showUpdateTab: true, showExternalImportTab: true, hasOptionalUpdate: false });
  it.each(tabs)('settings tab $id renders and stays within the stock baseline', async ({ id }) => {
    useAppStore.setState({ settingsInitialTab: id });
    const { container } = render(<SettingsModal />);
    await waitFor(() => expect(container.querySelector('.animate-pulse')).toBeNull(), { timeout: 10000 });
    if (id === 'voiceModel') await screen.findByText(zh.voice.settings.providerTitle, {}, { timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    census(`settings/${id}`, container.querySelector('main')!);
  });
  it.each(['deepseek', 'custom', 'claude'] as ModelProvider[])('models detail %s has no enforce jargon in text/title/placeholder/aria-label', async (provider) => {
    const { container } = render(<ModelSettings config={{ provider, model: settings.models.providers[provider as keyof typeof settings.models.providers].model }} onChange={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain('保存配置'));
    // Flush the settings.get hydration: the stored Custom Provider must reach the UI.
    await waitFor(() => expect(container.textContent).toContain('密钥已保存'));
    census(`models/${provider}`, container);
    fireEvent.click(screen.getByRole('button', { name: '新增模型服务', exact: true }));
    census(`models/${provider}/add-form`, container);
  });
  it('onboarding API route and both custom protocols have no enforce jargon', async () => {
    const { container } = render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await screen.findByTestId('onboarding-subscription-sources');
    census('wizard/subscription', container);
    fireEvent.click(screen.getByTestId('onboarding-route-api'));
    census('wizard/builtin', container);
    for (const name of ['OpenAI 兼容接口', 'Anthropic 兼容接口']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
      expect(container.textContent).toContain(zh.onboarding.baseUrlHint);
      census(`wizard/${name}`, container);
    }
  });
});
