// @vitest-environment jsdom

// FB-1800 同源问题在首启向导的验收（API-key 路由）：
// 向导保存默认模型时必须顺带接管出厂 taskStrategy.profiles.main（指向无 key 的
// provider 时）；main 已指向可用 provider 时不得改写；settings 读取失败时保存照常。
// 全部用例走生产入口 ModelOnboardingModal 渲染—填 key—验证—继续—完成，不手拼载荷。

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const sessionState = {
  currentSessionId: 'session-1',
  sessions: [{
    id: 'session-1',
    workingDirectory: '/workspace' as string | undefined,
    engine: { kind: 'native' },
  }],
  updateSessionEngine: vi.fn(),
};
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));

const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args) },
}));

import { ModelOnboardingModal } from '../../../src/renderer/components/onboarding/ModelOnboardingModal';
import { onboardingZh } from '../../../src/renderer/i18n/onboarding';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { AppSettings } from '../../../src/shared/contract';

const text = onboardingZh.onboarding;

const IPC_SETTINGS_DOMAIN = IPC_DOMAINS.SETTINGS;

/** 出厂形 settings：default/main 档都指向无 key 的 xiaomi（fresh data dir 的真实形态）。
 *  接管逻辑只读 settings.models（taskStrategy + providers），其余顶层字段不构造成本。 */
function buildFactoryLikeSettings(): AppSettings {
  return {
    models: {
      default: 'xiaomi',
      defaultProvider: 'xiaomi',
      providers: {
        xiaomi: { enabled: true, model: 'mimo-v2.6-flash' },
        zhipu: { enabled: true, model: 'glm-5' },
        deepseek: { enabled: true, model: 'deepseek-chat' },
      },
      routing: {
        code: { provider: 'deepseek', model: 'deepseek-chat' },
        vision: { provider: 'xiaomi', model: 'mimo-vision' },
        fast: { provider: 'zhipu', model: 'glm-5-flash' },
        gui: { provider: 'zhipu', model: 'glm-5-flash' },
      },
      taskStrategy: {
        mode: 'auto',
        defaultProfile: 'main',
        profiles: {
          fast: { provider: 'zhipu', model: 'glm-5-flash', reasoningEffort: 'low', maxTokens: 4096 },
          main: { provider: 'xiaomi', model: 'mimo-v2.6-flash', reasoningEffort: 'medium', maxTokens: 16384 },
          deep: { provider: 'deepseek', model: 'deepseek-reasoning', reasoningEffort: 'high', maxTokens: 32768 },
          vision: { provider: 'xiaomi', model: 'mimo-vision', reasoningEffort: 'medium', maxTokens: 4096 },
        },
        fallback: { enabled: true, preferSameProvider: true, allowCrossProvider: true },
        rules: [],
        updatedAt: 1725000000000,
      },
    },
  } as unknown as AppSettings; // 接管逻辑只读 settings.models，其余 AppSettings 顶层字段本用例不需要
}

/** main 已指向带 key 可用 provider 的 settings（zhipu 已配 key，向导不接管） */
function buildUsableMainSettings(): AppSettings {
  const settings = buildFactoryLikeSettings();
  settings.models.providers.zhipu = { enabled: true, model: 'glm-5', apiKey: 'sk-zhipu-existing', apiKeyConfigured: true };
  settings.models.taskStrategy!.profiles.main = {
    provider: 'zhipu',
    model: 'glm-5',
    reasoningEffort: 'medium',
    maxTokens: 16384,
  };
  return settings;
}

function mockSettingsGet(result: AppSettings | Promise<AppSettings>): void {
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'listSources') return Promise.resolve([]);
    if (action === 'listModels') {
      return Promise.resolve({ catalog: { version: 'fixture', updatedAt: '2026-07-30T00:00:00.000Z', engines: [] }, source: 'local_discovery', diagnostics: [] });
    }
    if (action === 'test_connection') return Promise.resolve({ success: true, latencyMs: 12 });
    if (action === 'discover_models') {
      return Promise.resolve({ success: true, latencyMs: 8, models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }] });
    }
    if (action === 'get') return Promise.resolve(result);
    if (action === 'set') return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
}

function mockSettingsGetRejecting(): void {
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'listSources') return Promise.resolve([]);
    if (action === 'listModels') {
      return Promise.resolve({ catalog: { version: 'fixture', updatedAt: '2026-07-30T00:00:00.000Z', engines: [] }, source: 'local_discovery', diagnostics: [] });
    }
    if (action === 'test_connection') return Promise.resolve({ success: true, latencyMs: 12 });
    if (action === 'discover_models') {
      return Promise.resolve({ success: true, latencyMs: 8, models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }] });
    }
    if (action === 'get') return Promise.reject(new Error('settings read boom'));
    if (action === 'set') return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
}

async function captureSettingsSetPayload(): Promise<Record<string, unknown>> {
  await waitFor(() => {
    expect(invokeDomain.mock.calls.some((call) => call[0] === IPC_SETTINGS_DOMAIN && call[1] === 'set')).toBe(true);
  });
  const setCalls = invokeDomain.mock.calls.filter((call) => call[0] === IPC_SETTINGS_DOMAIN && call[1] === 'set');
  expect(setCalls).toHaveLength(1);
  return setCalls[0][2] as Record<string, unknown>;
}

async function completeWizardViaApiKeyRoute(): Promise<void> {
  render(<ModelOnboardingModal onComplete={vi.fn()} />);
  fireEvent.click(await screen.findByTestId('onboarding-route-api'));
  await screen.findByTestId('onboarding-api-source');
  fireEvent.change(screen.getByPlaceholderText(text.apiKeyPlaceholder), {
    target: { value: 'sk-test-key' },
  });
  fireEvent.click(screen.getByRole('button', { name: text.verifyAndSelectModelButton }));
  await screen.findByTestId('onboarding-model-step');
  fireEvent.click(screen.getByTestId('onboarding-continue-to-chat'));
  fireEvent.click(await screen.findByTestId('onboarding-connectors-skip'));
  fireEvent.click(await screen.findByTestId('onboarding-voice-hotkey-skip'));
}

beforeEach(() => {
  appState.language = 'zh';
  appState.workingDirectory = '/workspace';
  sessionState.sessions[0].workingDirectory = '/workspace';
  invokeDomain.mockReset();
});

afterEach(cleanup);

describe('first-run wizard key save takes over the task main slot (FB-1800 sibling)', () => {
  it('(a) replaces a key-less factory main slot with the just-configured provider/model and still writes onboarding', async () => {
    mockSettingsGet(buildFactoryLikeSettings());
    await completeWizardViaApiKeyRoute();

    const payload = await captureSettingsSetPayload();
    const models = payload.models as Record<string, unknown>;
    const taskStrategy = models.taskStrategy as {
      profiles: { main: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number } };
    };
    expect(taskStrategy.profiles.main.provider).toBe('deepseek');
    expect(taskStrategy.profiles.main.model).toBe('deepseek-chat');
    // 原 main 档的 reasoningEffort / maxTokens 保留
    expect(taskStrategy.profiles.main.reasoningEffort).toBe('medium');
    expect(taskStrategy.profiles.main.maxTokens).toBe(16384);
    const onboarding = payload.onboarding as { completedAt?: number; defaultEngine?: string };
    expect(typeof onboarding.completedAt).toBe('number');
    expect(onboarding.defaultEngine).toBe('native');
    // 读取在保存之前
    const actionOrder = invokeDomain.mock.calls.map((call) => call[1]);
    expect(actionOrder.lastIndexOf('get')).toBeLessThan(actionOrder.indexOf('set'));
  });

  it('(b) leaves taskStrategy untouched when main already points at a usable (keyed) provider', async () => {
    mockSettingsGet(buildUsableMainSettings());
    await completeWizardViaApiKeyRoute();

    const payload = await captureSettingsSetPayload();
    const models = payload.models as Record<string, unknown>;
    expect(models.taskStrategy).toBeUndefined();
    expect(models.default).toBe('deepseek');
    expect(models.defaultProvider).toBe('deepseek');
    expect(models.providers).toHaveProperty('deepseek');
    const onboarding = payload.onboarding as { completedAt?: number; defaultEngine?: string };
    expect(typeof onboarding.completedAt).toBe('number');
    expect(onboarding.defaultEngine).toBe('native');
  });

  it('(c) still saves default/providers/onboarding and completes when the settings read rejects', async () => {
    mockSettingsGetRejecting();
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    fireEvent.click(await screen.findByTestId('onboarding-route-api'));
    await screen.findByTestId('onboarding-api-source');
    fireEvent.change(screen.getByPlaceholderText(text.apiKeyPlaceholder), {
      target: { value: 'sk-test-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: text.verifyAndSelectModelButton }));
    await screen.findByTestId('onboarding-model-step');
    fireEvent.click(screen.getByTestId('onboarding-continue-to-chat'));
    fireEvent.click(await screen.findByTestId('onboarding-connectors-skip'));
    fireEvent.click(await screen.findByTestId('onboarding-voice-hotkey-skip'));

    const payload = await captureSettingsSetPayload();
    const models = payload.models as Record<string, unknown>;
    expect(models.default).toBe('deepseek');
    expect(models.defaultProvider).toBe('deepseek');
    expect(models.providers).toHaveProperty('deepseek');
    const onboarding = payload.onboarding as { completedAt?: number; defaultEngine?: string };
    expect(typeof onboarding.completedAt).toBe('number');
    expect(onboarding.defaultEngine).toBe('native');
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
});
