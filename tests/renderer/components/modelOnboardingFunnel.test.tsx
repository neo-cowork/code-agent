// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEngineSourceDescriptor } from '../../../src/shared/contract/agentEngine';
import { listExternalEngineManifests } from '../../../src/shared/externalEngineManifest';

const cursorManifest = listExternalEngineManifests().find((manifest) => manifest.id === 'cursor_cli')!;

const appState = {
  modelConfig: {
    provider: 'deepseek',
    model: 'deepseek-chat',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
  },
  workingDirectory: '/workspace' as string | undefined,
  language: 'zh' as 'zh' | 'en',
  setLanguage: vi.fn(),
  cloudUIStrings: null,
};
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => selector ? selector(appState) : appState,
}));

const updateSessionEngine = vi.fn();
const sessionState = {
  currentSessionId: 'session-1',
  sessions: [{
    id: 'session-1',
    workingDirectory: '/workspace' as string | undefined,
    engine: { kind: 'native' },
  }],
  updateSessionEngine,
};
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));

const sources: AgentEngineSourceDescriptor[] = [
  {
    manifestId: 'native',
    kind: 'native',
    label: 'Neo',
    summary: 'Native',
    detected: true,
    selectable: true,
    authState: 'authenticated',
    modelSelection: 'neo_provider',
    iconAsset: '/code-agent/agent-neo-mark.svg',
    evidence: 'production',
    credentialOwner: 'neo',
    auditNotes: [],
  },
  {
    manifestId: 'codex_cli',
    kind: 'codex_cli',
    label: 'Codex CLI',
    summary: 'Official CLI',
    detected: true,
    selectable: true,
    authState: 'authenticated',
    version: 'codex-cli 1.0.0',
    modelSelection: 'runtime_catalog',
    evidence: 'production',
    credentialOwner: 'official_client',
    auditNotes: [],
  },
  {
    manifestId: 'codebuddy_code',
    kind: 'codebuddy_code',
    label: 'WorkBuddy',
    summary: 'Recommendation',
    detected: false,
    selectable: false,
    authState: 'not_checked',
    modelSelection: 'runtime_catalog',
    recommendation: { label: '推荐安装', reason: '复用 WorkBuddy / CodeBuddy 账号' },
    evidence: 'production',
    credentialOwner: 'official_client',
    auditNotes: [],
  },
  {
    manifestId: 'grok_cli',
    kind: 'grok_cli',
    label: 'Grok Build',
    summary: 'Official Grok CLI',
    detected: true,
    selectable: true,
    authState: 'authenticated',
    version: 'grok 0.2.114',
    modelSelection: 'runtime_catalog',
    evidence: 'production',
    credentialOwner: 'official_client',
    auditNotes: [],
  },
  {
    manifestId: 'qoder_work',
    label: 'Qoder Work',
    summary: 'Detected local spike',
    detected: true,
    selectable: false,
    authState: 'needs_login',
    version: '1.0.47',
    modelSelection: 'unavailable',
    recommendation: { label: '需要登录', reason: '登录后继续验证' },
    evidence: 'local_spike',
    credentialOwner: 'official_client',
    auditNotes: [],
  },
  {
    manifestId: cursorManifest.id,
    label: cursorManifest.label,
    summary: cursorManifest.summary,
    detected: false,
    selectable: false,
    authState: 'not_checked',
    modelSelection: cursorManifest.modelSelection,
    recommendation: cursorManifest.recommendation,
    evidence: cursorManifest.adapter.evidence,
    credentialOwner: cursorManifest.adapter.credentialOwner,
    auditNotes: [],
  },
];

const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args) },
}));

import { ModelOnboardingModal } from '../../../src/renderer/components/onboarding/ModelOnboardingModal';
import { onboardingZh } from '../../../src/renderer/i18n/onboarding';

const text = onboardingZh.onboarding;

beforeEach(() => {
  appState.language = 'zh';
  appState.workingDirectory = '/workspace';
  sessionState.sessions[0].workingDirectory = '/workspace';
  updateSessionEngine.mockReset();
  updateSessionEngine.mockResolvedValue(undefined);
  invokeDomain.mockReset();
  invokeDomain.mockImplementation((_domain: string, action: string, payload?: unknown) => {
    if (action === 'listSources') return Promise.resolve(sources);
    if (action === 'listModels') {
      return Promise.resolve({
        catalog: {
          version: 'fixture',
          updatedAt: '2026-07-30T00:00:00.000Z',
          engines: [{
            kind: 'codex_cli',
            defaultModel: 'gpt-5.5',
            models: [
              { id: 'gpt-5.5', label: 'GPT-5.5', capabilities: ['code'], recommended: true },
              { id: 'gpt-5.4', label: 'GPT-5.4', capabilities: ['code'] },
            ],
          }, {
            kind: 'grok_cli',
            defaultModel: 'grok-4.5',
            models: [
              { id: 'grok-4.5', label: 'Grok 4.5', capabilities: ['code', 'reasoning'], recommended: true },
            ],
          }],
        },
        source: 'local_discovery',
        diagnostics: [],
      });
    }
    if (action === 'test_connection') return Promise.resolve({ success: true, latencyMs: 12 });
    if (action === 'discover_models') {
      return Promise.resolve({
        success: true,
        latencyMs: 8,
        models: [{ id: 'claude-sonnet-4', label: 'Claude Sonnet 4' }],
      });
    }
    if (action === 'get') return Promise.resolve({});
    if (action === 'set') return Promise.resolve(undefined);
    throw new Error(`Unexpected action: ${action} ${JSON.stringify(payload)}`);
  });
});

afterEach(cleanup);

async function continuePastModelAndSkipVoiceHotkey() {
  fireEvent.click(screen.getByTestId('onboarding-continue-to-chat'));
  fireEvent.click(await screen.findByTestId('onboarding-connectors-skip'));
  fireEvent.click(await screen.findByTestId('onboarding-voice-hotkey-skip'));
}

describe('two-step onboarding', () => {
  it('greets first-run users with the habitat welcome above the first step', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await screen.findByTestId('onboarding-subscription-sources');

    const welcome = screen.getByTestId('onboarding-welcome');
    expect(welcome.querySelector('[data-planet="earth"]')).toBeTruthy();
    expect(welcome.textContent).toContain('抵达新栖地。');
    expect(welcome.textContent).toContain('Neo 是你地球之外的新居所。');
    expect(screen.getByTestId('onboarding-step-source').getAttribute('data-active')).toBe('true');
  });

  it('drops the habitat welcome once configuration advances to the model step', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('onboarding-subscription-sources')
      .then((section) => section.querySelector('[data-onboarding-engine="codex_cli"]')!));

    expect(screen.getByTestId('onboarding-step-model').getAttribute('data-active')).toBe('true');
    expect(screen.queryByTestId('onboarding-welcome')).toBeNull();
  });

  it('contains only source and default-model steps', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await screen.findByTestId('onboarding-subscription-sources');

    expect(screen.getByTestId('onboarding-step-source').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('onboarding-step-model')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-step-connectors')).toBeNull();
    expect(screen.queryByTestId('onboarding-done')).toBeNull();
    expect(screen.queryByText('Neo')).toBeNull();
    expect(screen.getByTestId('onboarding-route-subscription').getAttribute('role')).toBe('tab');
    expect(screen.getByTestId('onboarding-route-subscription').getAttribute('aria-selected')).toBe('true');
  });

  it('selects a detected official client by clicking the whole card and enters chat directly', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    fireEvent.click(await screen.findByTestId('onboarding-subscription-sources')
      .then((section) => section.querySelector('[data-onboarding-engine="codex_cli"]')!));

    expect(screen.getByTestId('onboarding-step-model').getAttribute('data-active')).toBe('true');
    expect(screen.getByText('GPT-5.5')).toBeTruthy();
    await continuePastModelAndSkipVoiceHotkey();

    await waitFor(() => expect(updateSessionEngine).toHaveBeenCalledWith('session-1', expect.objectContaining({
      kind: 'codex_cli',
      model: 'gpt-5.5',
      permissionProfile: 'read_only',
    })));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('onboarding-done')).toBeNull();
  });

  it('selects detected Grok Build with its discovered model', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    fireEvent.click(await screen.findByTestId('onboarding-subscription-sources')
      .then((section) => section.querySelector('[data-onboarding-engine="grok_cli"]')!));

    expect(screen.getByText('Grok 4.5')).toBeTruthy();
    await continuePastModelAndSkipVoiceHotkey();

    await waitFor(() => expect(updateSessionEngine).toHaveBeenCalledWith('session-1', expect.objectContaining({
      kind: 'grok_cli',
      model: 'grok-4.5',
      permissionProfile: 'read_only',
    })));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('completes a quick conversation without bypassing the external workspace gate', async () => {
    sessionState.sessions[0].workingDirectory = undefined;
    appState.workingDirectory = undefined;
    const onComplete = vi.fn();

    render(<ModelOnboardingModal onComplete={onComplete} />);
    fireEvent.click(await screen.findByTestId('onboarding-subscription-sources')
      .then((section) => section.querySelector('[data-onboarding-engine="codex_cli"]')!));
    await continuePastModelAndSkipVoiceHotkey();

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(updateSessionEngine).not.toHaveBeenCalled();

  });

  it('shows missing recommendations without making them selectable', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await screen.findByText('WorkBuddy');
    const card = document.querySelector('[data-onboarding-recommendation="codebuddy_code"]');

    expect(card).toBeTruthy();
    expect(card?.querySelector('button')).toBeNull();
    expect(card?.textContent).toContain('Adapter 已开放');
    expect(card?.textContent).toContain('未安装');
  });

  it('shows a detected Qoder Work CLI as login-gated without making it selectable', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await screen.findByText('Qoder Work');
    const card = document.querySelector('[data-onboarding-engine-status="qoder_work"]');

    expect(card).toBeTruthy();
    expect(card?.querySelector('button')).toBeNull();
    expect(card?.textContent).toContain('CLI 未登录');
    expect(card?.textContent).toContain('生产 Adapter 未开放');
    expect(card?.textContent).toContain('需登录');
  });

  it('offers Anthropic-compatible API and forwards the claude protocol to probing and saving', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('onboarding-route-api'));
    expect(screen.getByTestId('onboarding-route-api').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByText('Anthropic 兼容接口'));
    expect(screen.getByRole('heading', { name: 'Anthropic 兼容接口' })).toBeTruthy();
    expect(screen.getAllByText(/Anthropic Messages/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/OpenAI 兼容中转站/)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('https://example.com/v1'), {
      target: { value: 'https://anthropic-gateway.example/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText(text.apiKeyPlaceholder), {
      target: { value: 'sk-test' },
    });
    fireEvent.click(screen.getByText('验证并选择模型'));

    await screen.findByText('Claude Sonnet 4');
    expect(invokeDomain).toHaveBeenCalledWith(
      expect.any(String),
      'test_connection',
      expect.objectContaining({ provider: 'custom', protocol: 'claude' }),
    );
    await continuePastModelAndSkipVoiceHotkey();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'custom',
      model: 'claude-sonnet-4',
      protocol: 'claude',
    })));
  });

  it('renders subscription route, API route, and default-model step in English with zero CJK', async () => {
    const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
    appState.language = 'en';

    render(<ModelOnboardingModal onComplete={vi.fn()} onSkip={vi.fn()} />);
    await screen.findByTestId('onboarding-subscription-sources');

    const dialog = screen.getByRole('dialog', { name: 'Set up Neo' });
    expect(dialog.textContent).toContain('Official account / subscription');
    expect(dialog.textContent).toContain('Detected on this computer');
    expect(dialog.textContent).toContain('Not installed / recommended');
    const cursorCard = dialog.querySelector('[data-onboarding-recommendation="cursor_cli"]');
    expect(cursorCard?.textContent).toContain('Requires official protocol verification before it can be selected in Neo.');
    expect(cursorCard?.textContent).toContain('Recommended');
    expect(dialog.textContent).not.toMatch(HAN_RE);

    // Advance to subscription default-model step
    fireEvent.click(dialog.querySelector('[data-onboarding-engine="codex_cli"]')!);
    await screen.findByTestId('onboarding-model-step');
    expect(dialog.textContent).toContain('Confirm default model');
    expect(dialog.textContent).toContain('Codex CLI shows only the models detected from this client.');
    expect(dialog.textContent).not.toMatch(HAN_RE);

    // Go back and switch to API Key route
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(await screen.findByTestId('onboarding-route-api'));
    await screen.findByTestId('onboarding-api-source');
    expect(dialog.textContent).toContain('Connect an official API or compatible endpoint');
    expect(dialog.textContent).toContain('Everyday chat, coding, and cost-effective tasks');
    expect(dialog.textContent).toContain('Zhipu GLM');
    expect(dialog.textContent).toContain('Volcengine / Doubao');
    expect(dialog.textContent).toContain('Xiaomi MiMo');
    expect(dialog.textContent).toContain('OpenAI-compatible endpoint');
    expect(dialog.textContent).toContain('Anthropic-compatible endpoint');
    expect(dialog.textContent).not.toMatch(HAN_RE);

    // Verify & advance to API default-model step
    fireEvent.change(screen.getByPlaceholderText("Paste this provider's API key"), {
      target: { value: 'sk-en-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & choose model' }));
    await screen.findByTestId('onboarding-model-step');
    expect(dialog.textContent).toContain('DeepSeek passed connection verification.');
    expect(dialog.textContent).not.toMatch(HAN_RE);
  });

  it('preserves byte-identical Simplified Chinese strings across all three wizard screens', async () => {
    appState.language = 'zh';
    render(<ModelOnboardingModal onComplete={vi.fn()} onSkip={vi.fn()} />);
    await screen.findByTestId('onboarding-subscription-sources');

    const dialog = screen.getByRole('dialog', { name: '初始化 Neo' });

    // Pre-change zh snapshot of subscription route strings
    const expectedSubscriptionStrings = [
      '初始化 Neo',
      '抵达新栖地。',
      'Neo 是你地球之外的新居所。花一分钟配好引擎，我们就出发。',
      '连接来源',
      '默认模型',
      '官方账号 / 订阅',
      'API Key',
      '选择本机已登录的官方客户端',
      '整卡点击后直接进入默认模型；未通过 Adapter 门禁的来源不会伪装成可用。',
      '本机已检测',
      'codex-cli 1.0.0 · Adapter 已开放 · 官方登录已确认',
      '可用',
      '已检测 · CLI 未登录 · 生产 Adapter 未开放',
      '需登录',
      '未安装 / 推荐项',
      'Adapter 已开放 · 本机未检测到客户端',
      '未安装',
      '需要完成官方协议与实机验证后才能在 Neo 中选择。',
      '推荐了解',
      '官方登录凭证始终由对应客户端管理',
      '跳过，稍后在设置里配置',
    ];
    for (const expected of expectedSubscriptionStrings) {
      expect(dialog.textContent).toContain(expected);
    }

    // Subscription default-model step
    fireEvent.click(dialog.querySelector('[data-onboarding-engine="codex_cli"]')!);
    await screen.findByTestId('onboarding-model-step');
    for (const expected of [
      '确认默认模型',
      'Codex CLI 只展示探测到的真实模型能力。',
      '返回',
      '下一步',
    ]) {
      expect(dialog.textContent).toContain(expected);
    }

    // Back to API route
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    fireEvent.click(await screen.findByTestId('onboarding-route-api'));
    await screen.findByTestId('onboarding-api-source');
    const expectedApiStrings = [
      '连接官方 API 或兼容接口',
      '先验证接口并读取真实模型目录，再进入默认模型。',
      '日常聊天、代码和高性价比任务',
      '长文本、中文写作和文档处理',
      '智谱 GLM',
      '国内直连、视觉和多模态能力',
      '办公文档、多模态和国内生态',
      'GPT 系列官方 API',
      'Anthropic 官方 API',
      'Google Gemini 官方 API',
      'MiniMax 官方 API',
      'xAI Grok 官方 API',
      '高速推理官方 API',
      '联网搜索官方 API',
      '火山 / 豆包',
      '火山引擎 Ark 官方 API',
      'LongCat API 开放平台',
      '小米 MiMo',
      '小米 MiMo Token Plan',
      'OpenAI 兼容接口',
      '适用于 new-api、one-api 和其他 OpenAI-compatible 网关。',
      'Anthropic 兼容接口',
      '适用于实现 Anthropic Messages / models 协议的自定义接口。',
      '密钥只存在这台电脑上，不会上传。',
      '验证并选择模型',
    ];
    for (const expected of expectedApiStrings) {
      expect(dialog.textContent).toContain(expected);
    }

    // API default-model step
    fireEvent.change(screen.getByPlaceholderText(text.apiKeyPlaceholder), {
      target: { value: 'sk-zh-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: '验证并选择模型' }));
    await screen.findByTestId('onboarding-model-step');
    expect(dialog.textContent).toContain('DeepSeek 已通过连接验证。');
  });
});
