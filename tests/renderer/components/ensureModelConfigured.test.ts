// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomainMock = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  openSettingsTab: vi.fn(),
  openModelSettings: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: invokeDomainMock },
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: { getState: () => appState },
}));

import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { ensureModelConfigured } from '../../../src/renderer/utils/ensureModelConfigured';

function mockResolution(settings: unknown, effective?: unknown) {
  invokeDomainMock.mockImplementation(async (_domain, action) => {
    if (action === 'get') return settings;
    if (action === 'getEffectiveModel') {
      if (effective instanceof Error) throw effective;
      return effective ?? null;
    }
    throw new Error(`Unexpected action: ${action}`);
  });
}

beforeEach(() => {
  invokeDomainMock.mockReset();
  appState.openSettingsTab.mockClear();
  appState.openModelSettings.mockClear();
  useToastStore.setState({ toasts: [] });
});

describe('ensureModelConfigured effective session model', () => {
  it('accepts a keyed session override when the default is unkeyed', async () => {
    mockResolution({
      models: { default: 'openai', providers: { openai: { enabled: true }, xiaomi: { enabled: true, apiKeyConfigured: true } } },
    }, { provider: 'xiaomi', model: 'mimo-v2.6-flash', adaptive: false });

    await expect(ensureModelConfigured(zh, 'zh', { currentSessionId: 'session-1' })).resolves.toBe(true);
    expect(invokeDomainMock).toHaveBeenCalledWith(IPC_DOMAINS.SESSION, 'getEffectiveModel', { sessionId: 'session-1' });
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(appState.openModelSettings).not.toHaveBeenCalled();
  });

  it('blocks an unkeyed override and names its provider even when the default is keyed', async () => {
    mockResolution({
      models: { default: 'xiaomi', providers: { xiaomi: { enabled: true, apiKeyConfigured: true }, openai: { enabled: true } } },
    }, { provider: 'openai', model: 'gpt-5.5', adaptive: false });

    await expect(ensureModelConfigured(zh, 'zh', { currentSessionId: 'session-1' })).resolves.toBe(false);
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      zh.modelSetup.missingApiKeyWithAlternatives.replace('{provider}', 'OpenAI'),
    );
    expect(appState.openModelSettings).toHaveBeenCalledExactlyOnceWith('openai');
  });

  it('names the override provider when both models are unkeyed', async () => {
    mockResolution({
      models: { default: 'openai', providers: { openai: { enabled: true }, claude: { enabled: true } } },
    }, { provider: 'claude', model: 'claude-sonnet-4-6', adaptive: false });

    await expect(ensureModelConfigured(zh, 'zh', { currentSessionId: 'session-1' })).resolves.toBe(false);
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      zh.modelSetup.missingApiKey.replace('{provider}', 'Anthropic Claude'),
    );
    expect(appState.openModelSettings).toHaveBeenCalledExactlyOnceWith('claude');
  });

  it('falls back to the default for an auto override even without the adaptive flag', async () => {
    mockResolution({
      models: { default: 'xiaomi', providers: { xiaomi: { enabled: true, apiKeyConfigured: true } } },
    }, { provider: 'openai', model: 'auto', adaptive: false });

    await expect(ensureModelConfigured(zh, 'zh', { currentSessionId: 'session-1' })).resolves.toBe(true);
    expect(appState.openModelSettings).not.toHaveBeenCalled();
  });

  it('falls back to the unkeyed default when the effective-model IPC fails', async () => {
    mockResolution({
      models: { default: 'openai', providers: { openai: { enabled: true }, xiaomi: { enabled: true, apiKeyConfigured: true } } },
    }, new Error('IPC unavailable'));

    await expect(ensureModelConfigured(zh, 'zh', { currentSessionId: 'session-1' })).resolves.toBe(false);
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain('OpenAI');
    expect(appState.openModelSettings).toHaveBeenCalledExactlyOnceWith('openai');
  });

  it('keeps a new session on the default provider without requesting an override', async () => {
    mockResolution({
      models: { default: 'openai', providers: { openai: { enabled: true }, xiaomi: { enabled: true, apiKeyConfigured: true } } },
    });

    await expect(ensureModelConfigured(zh, 'zh', { currentSessionId: null })).resolves.toBe(false);
    expect(invokeDomainMock).not.toHaveBeenCalledWith(IPC_DOMAINS.SESSION, 'getEffectiveModel', expect.anything());
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain('OpenAI');
    expect(appState.openModelSettings).toHaveBeenCalledExactlyOnceWith('openai');
  });
});
