// @vitest-environment jsdom
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { en } from '../../../src/renderer/i18n/en';
import { sidebarZh } from '../../../src/renderer/i18n/sidebar';
import table from '../../../src/renderer/i18n/settingsTerms.json';
import { getProviderDisplayName, getSettingsVocabulary, localizeSettingsTerms } from '../../../src/renderer/i18n/settingsVocabulary';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { useExternalImportStore } from '../../../src/renderer/stores/externalImportStore';
import { useDoctorStore } from '../../../src/renderer/stores/doctorStore';

import { compareSettingsJargon, findSettingsJargon, scanSettingsJargon } from '../../../scripts/ci/check-settings-jargon.mjs';
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
    fireEvent.click(screen.getByRole('button', { name: '新增模型服务' }));
    census(`models/${provider}/add-form`, container);
  });
  it('models-page unsaved-changes dialog has no enforce jargon', async () => {
    useAppStore.setState({ settingsInitialTab: 'model' });
    render(<SettingsModal />);
    const keyInput = await screen.findByPlaceholderText(zh.settings.model.connection.apiKeyPlaceholder, {}, { timeout: 10000 });
    fireEvent.change(keyInput, { target: { value: 'weekly-report-key' } });
    await screen.findByText(zh.settings.unsavedChanges.badge);
    fireEvent.click(screen.getByRole('button', { name: zh.settings.tabs.appearance }));
    const message = await screen.findByText(zh.settings.unsavedChanges.message);
    census('models/unsaved-dialog', screen.getByText(zh.settings.unsavedChanges.title).closest('[role="dialog"], [role="alertdialog"]') ?? document.body);
    expect(message.textContent).toContain('模型服务');
  });
  it.each(['通用模型', 'api key', 'provider'])('settings search results for %s lead to the models page without enforce jargon', async (query) => {
    const { container } = render(<SettingsModal />);
    const input = await screen.findByPlaceholderText(zh.settings.searchPlaceholder);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: query } });
    const result = (await screen.findAllByRole('button')).find((button) => button.textContent?.startsWith(zh.settings.tabs.model) && button.closest('.relative')?.contains(input));
    expect(result?.textContent).toMatch(/模型服务|密钥/);
    census(`models/search-results/${query}`, container.querySelector('aside')!);
  });
  it('doctor rows translate host-supplied check text at the display boundary', async () => {
    useDoctorStore.setState({ isRunning: false, runningCategory: null, lastError: null, startupCheckDone: true, report: { timestamp: 1_720_000_000_000, durationMs: 1200, summary: { pass: 0, warn: 1, fail: 1, skip: 2 }, items: [
      { category: 'network', name: 'Provider connectivity', status: 'skip', message: '已跳过（skipNetwork=true）' },
      { category: 'network', name: 'DeepSeek', status: 'skip', message: '未配置 API Key' },
      { category: 'provider_health', name: 'Provider 健康监控', status: 'warn', message: '当前后端进程尚无运行时数据', suggestion: '错误率偏高，可观察是否需要切换 provider' },
      { category: 'provider_health', name: '快模型鉴权', status: 'fail', message: 'API Key 可能已失效或过期', suggestion: '请前往模型设置更新对应 Provider 的 API Key', details: 'HTTP 401 Unauthorized' },
    ] } });
    useAppStore.setState({ settingsInitialTab: 'doctor' });
    const { container } = render(<SettingsModal />);
    await screen.findByText('模型服务连通性', {}, { timeout: 10000 });
    for (const button of screen.getAllByRole('button')) if (button.textContent?.includes('模型服务健康监控')) fireEvent.click(button);
    expect(container.textContent).toContain('未配置密钥');
    expect(container.textContent).toContain('请前往模型设置更新对应模型服务的密钥');
    expect(container.textContent).toContain('HTTP 401 Unauthorized');
    census('settings/doctor/host-text', container.querySelector('main')!);
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

describe('settings vocabulary', () => {
  it('uses the single term table in the zh model and wizard copy; preserves English labels', () => {
    const words = getSettingsVocabulary('zh');
    for (const term of table.terms.filter((entry) => entry.mode === 'enforce')) {
      expect(Object.values(words)).toContain(term.human);
    }
    expect(zh.settings.model.providerSection.title).toBe(words.provider);
    expect(zh.settings.model.connection.apiKey).toBe(words.keyLabel);
    expect(zh.settings.model.list.addProvider).toBe('新增模型服务');
    expect(zh.settings.model.list.searchPlaceholder).toBe('搜索模型服务或模型…');
    expect(zh.settings.model.header.apiKeySaved).toBe('密钥已保存');
    expect(zh.settings.model.header.selectableLabel).toBe('显示在模型选择里');
    expect(zh.settings.model.models.selectableLabel).toBe('显示在模型选择里');
    expect(zh.settings.model.connection.baseUrlHint).toBe(words.addressHint);
    expect(zh.onboarding.baseUrlHint).toBe(words.addressHint);
    expect(zh.settings.model.addProvider.baseUrlHint).toBe(words.addressHint);
    expect(en.settings.model.list.addProvider).toBe('Add Provider');
    expect(getSettingsVocabulary('en').keyLabel).toBe('API Key');
  });

  it('translates catalog default names but preserves user names in both languages', () => {
    expect(getProviderDisplayName('custom', 'Custom Provider', 'Custom Provider', 'zh')).toBe('自定义模型服务');
    expect(getProviderDisplayName('custom', undefined, 'Custom Provider', 'zh')).toBe('自定义模型服务');
    expect(getProviderDisplayName('custom', 'Custom Provider', 'Custom Provider', 'en')).toBe('Custom Provider');
    expect(getProviderDisplayName('custom', '我的服务', 'Custom Provider', 'zh')).toBe('我的服务');
    expect(getProviderDisplayName('zhipu', 'Zhipu GLM', '智谱 AI', 'zh')).toBe('智谱 AI');
    expect(getProviderDisplayName('zhipu', 'Zhipu GLM', 'Zhipu AI', 'en')).toBe('Zhipu GLM');
  });

  it('search index, unsaved dialog and compaction pointer use the same words', () => {
    const words = getSettingsVocabulary('zh');
    expect(zh.settings.searchIndex.modelProviders).toBe(words.provider);
    expect(zh.settings.searchIndex.apiKey).toBe(words.keyLabel);
    expect(zh.settings.unsavedChanges.message).toBe('「通用模型」里有尚未保存的模型服务配置修改，离开后会被丢弃。');
    expect(zh.settings.conversation.model.description).toBe('实际可用模型与密钥配置在「通用模型」页，本页只显示当前生效值。');
    expect(en.settings.searchIndex.apiKey).toBe('API Key');
    expect(zh.settings.privacyLabels.transcriptionService).toBe('转写服务: ');
    expect(en.settings.privacyLabels.transcriptionService).toBe('Provider: ');
  });

  it('translates host-supplied text at the display boundary without touching English or verbatim literals', () => {
    expect(localizeSettingsTerms('Provider connectivity', 'zh')).toBe('模型服务连通性');
    expect(localizeSettingsTerms('Provider 健康监控', 'zh')).toBe('模型服务健康监控');
    expect(localizeSettingsTerms('请前往模型设置更新对应 Provider 的 API Key', 'zh')).toBe('请前往模型设置更新对应模型服务的密钥');
    expect(localizeSettingsTerms('数据: provider API key、base URL', 'zh')).toBe('数据: 模型服务密钥、接口地址');
    expect(localizeSettingsTerms('使用 X-API-Key 头，不是 API Key 字段', 'zh')).toBe('使用 X-API-Key 头，不是密钥字段');
    expect(localizeSettingsTerms('读取 apiKeyConfigured 与 OpenAI provider 状态', 'zh')).toBe('读取 apiKeyConfigured 与 OpenAI 模型服务状态');
    expect(localizeSettingsTerms('choose the isolated Managed Browser provider.', 'zh')).toBe('choose the isolated Managed Browser provider.');
    expect(localizeSettingsTerms('Provider 健康监控', 'en')).toBe('Provider 健康监控');
    expect(localizeSettingsTerms('Provider connectivity', 'en')).toBe('Provider connectivity');
  });
});

describe('settings jargon gate', () => {
  it('checks English-only text, case, plurals and separators with a suggested word', () => {
    for (const text of ['Provider', 'Providers', 'Base URL', 'base-url', 'API Key', 'api-key', 'API \n Key', '{Provider}']) {
      expect(findSettingsJargon(text).some((hit) => hit.mode === 'enforce')).toBe(true);
    }
    expect(findSettingsJargon('模型服务 / 接口地址 / 密钥 /v1 OpenAI Claude')).toEqual([]);
    expect(findSettingsJargon('MCP')[0].mode).toBe('report');
    expect(findSettingsJargon('apiKeyConfigured')).toEqual([]);
  });

  it('skips only verbatim literals the user must copy; a term next to one still counts', () => {
    expect(table.literals).toEqual(['/v1', 'X-API-Key', 'mimo providers login']);
    expect(findSettingsJargon('使用 X-API-Key 头进行认证。')).toEqual([]);
    expect(findSettingsJargon('首次使用前需运行 mimo providers login 完成账号授权。')).toEqual([]);
    expect(findSettingsJargon('X-API-Key 里填 API Key').map((hit) => [hit.term, hit.index])).toEqual([['API Key', 13]]);
    expect(findSettingsJargon('providers login').map((hit) => hit.term)).toEqual(['Provider']);
  });

  it('counts down stock by surface and cannot exempt the models or wizard', () => {
    const row = { surface: 'settings/search', hits: findSettingsJargon('API Key') };
    const stock = [{ surface: row.surface, term: 'API Key', count: 1, reason: 'N-FIX-UI-ENGLISH-JARGON-SWEEP: search stock' }];
    expect(compareSettingsJargon([row], stock)).toEqual([]);
    expect(compareSettingsJargon([{ ...row, hits: findSettingsJargon('API Key API Key') }], stock).join('\n')).toContain('2 > baseline 1; use 密钥');
    expect(compareSettingsJargon([{ ...row, surface: 'models/custom' }], stock)).not.toEqual([]);
    expect(compareSettingsJargon([row], [{ ...stock[0], reason: '' }])).not.toEqual([]);
  });

  it('AST scan catches English-only JSX and locale values while leaving the English bundle alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-jargon-'));
    try {
      for (const dir of ['src/renderer/i18n', 'src/renderer/components/features/settings', 'src/renderer/components/onboarding']) fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, 'src/renderer/i18n/settingsTerms.json'), JSON.stringify(table));
      fs.writeFileSync(path.join(root, 'src/renderer/i18n/onboarding.ts'), "export const onboardingZh = { label: 'API Key' }; export const onboardingEn = { label: 'Provider' };");
      fs.writeFileSync(path.join(root, 'src/renderer/components/onboarding/NewWizard.tsx'), 'const View = () => <div><label>API Key</label><input title="Provider" placeholder="Base URL" aria-label="Provider" /></div>;');
      const rows = scanSettingsJargon(root);
      expect(rows.find((row) => row.surface.endsWith('onboarding.ts'))?.hits.map((hit) => hit.term)).toEqual(['API Key']);
      expect(rows.find((row) => row.surface.endsWith('NewWizard.tsx'))?.hits.map((hit) => hit.term)).toEqual(['API Key', 'Provider', 'Base URL', 'Provider']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('real source census stays below its owned stock counts', () => {
    expect(compareSettingsJargon(scanSettingsJargon(), baseline.source)).toEqual([]);
  });
});

describe('host unlock hint mirrors the zh settings labels', () => {
  // The hint is model-visible text: the host literal and every recorded request must name the
  // same path a zh user sees (sidebar entry -> tab -> service row -> row action).
  const zhPath = `${sidebarZh.sidebar.menuSettings} -> ${zh.settings.tabs.model} -> ${zh.settings.model.providers.zhipu.name}（${zh.settings.model.list.addKey}）`;
  const repoRoot = path.resolve(__dirname, '../../..');
  it('host literal equals the path built from the zh bundle', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'src/host/tools/modules/network/toolAvailability.ts'), 'utf8');
    expect(zhPath).toBe('设置 -> 通用模型 -> 智谱 AI（添加）');
    expect(source).toContain(`const ZHIPU_SETTINGS_PATH_ZH = '${zhPath}';`);
    expect(findSettingsJargon(zhPath)).toEqual([]);
  });
  it('every recorded request snapshot that carries the hint uses the same zh path', () => {
    const corpus = path.join(repoRoot, 'packages/internal/evaluation-center/snapshots/request-replay');
    const requests = fs.readdirSync(corpus, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((session) =>
      fs.readdirSync(path.join(corpus, session.name), { withFileTypes: true }).filter((turn) => turn.isDirectory())
        .map((turn) => path.join(corpus, session.name, turn.name, 'canonical-request.json')));
    const withHint = requests.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') })).filter((request) => request.text.includes('以下能力未开启'));
    expect(withHint.length).toBeGreaterThan(0);
    for (const request of withHint) expect(request.text, request.file).toContain(`开启：${zhPath}。`);
  });
});
