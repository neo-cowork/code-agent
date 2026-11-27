// @vitest-environment jsdom
// Web 版跳过登录落到模型页时，缺密钥 toast 不能再叫用户去「添加密钥」（网页版存不了）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const webMode = vi.hoisted(() => ({ value: true }));
const invokeDomainMock = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({ openSettingsTab: vi.fn(), openModelSettings: vi.fn() }));

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain: invokeDomainMock } }));
vi.mock('../../../src/renderer/stores/appStore', () => ({ useAppStore: { getState: () => appState } }));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/utils/platform')>()),
  isWebMode: () => webMode.value,
}));

import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { ensureModelConfigured } from '../../../src/renderer/utils/ensureModelConfigured';

const unkeyed = { models: { default: 'openai', providers: { openai: { enabled: true } } } };
const unkeyedWithOther = { models: { default: 'openai', providers: { openai: { enabled: true }, xiaomi: { enabled: true, apiKeyConfigured: true } } } };

beforeEach(() => {
  webMode.value = true;
  invokeDomainMock.mockReset();
  appState.openSettingsTab.mockClear();
  appState.openModelSettings.mockClear();
  useToastStore.setState({ toasts: [] });
});

describe.each([['zh', zh], ['en', en]] as const)('ensureModelConfigured web toast (%s)', (language, locale) => {
  it('uses web wording when another model is configured', async () => {
    invokeDomainMock.mockResolvedValue(unkeyedWithOther);
    await expect(ensureModelConfigured(locale, language, { openSettingsWhenReady: true })).resolves.toBe(false);
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(locale.modelSetup.webSetupDesktopOnly.replace('{provider}', language === 'zh' ? 'OpenAI' : 'OpenAI'));
    expect(appState.openModelSettings).toHaveBeenCalledWith('openai');
  });

  it.each([true, false])('opens model settings without a duplicate toast when no model exists (web=%s)', async (isWeb) => {
    webMode.value = isWeb;
    invokeDomainMock.mockResolvedValue(unkeyed);
    await ensureModelConfigured(locale, language, { openSettingsWhenReady: true });
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(appState.openModelSettings).toHaveBeenCalledExactlyOnceWith('openai');
  });
});
