// @vitest-environment jsdom
// Desktop 桌面模式「Save configuration」全链路 hermetic 测试（N-…-SAVE-HERMETIC）：
// 渲染真实 ModelSettings（isWebMode()=false），把 renderer 的 ipcService.invokeDomain
// 桥接进真实 host 链——真实 registerSettingsHandlers 分发 + 真实 ConfigService 落在
// 临时数据目录（只按 tests/unit/ipc/settingsAccess.ipc.test.ts 的方式 mock auth /
// providerIconAssets；host platform 的 app.getPath 指进临时目录，config.json 与
// secure-storage 都不落真实用户目录）。
// 不 mock 中段：type key → 点 Save → 走真实 handleSet → updateSettings →
// storage.setApiKey + config.json 落盘 → 徽标消失 → 新一次 get 让
// hasConfiguredDefaultRuntimeModel（ensureModelConfigured 的同一判据）为 true，
// 全程组件不重挂载。
import React, { useState } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';
import type { AppSettings, ModelConfig } from '../../../src/shared/contract';
import { getProviderEndpointForProtocol, getProviderInfo } from '../../../src/shared/constants';
import { buildRuntimeModelOptions, hasConfiguredDefaultRuntimeModel } from '../../../src/shared/modelRuntime';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { toast, useToastStore } from '../../../src/renderer/hooks/useToast';
import { DomainInvokeError } from '../../../src/renderer/services/ipcService';
import { ModelSettings } from '../../../src/renderer/components/features/settings/tabs/ModelSettings';
import type { DiscoverModelsResult } from '../../../src/renderer/components/features/settings/tabs/ModelSettings.helpers';
import { registerSettingsHandlers } from '../../../src/host/ipc/settings.ipc';
import { ConfigService } from '../../../src/host/services/core/configService';
import { getSecureStorage } from '../../../src/host/services/core/secureStorage';
import { resetPolicyEngine } from '../../../src/host/permissions/policyEngine';

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: string; email: string; isAdmin?: boolean },
  saveProviderIconAsset: vi.fn(),
  resolveProviderIconAsset: vi.fn(),
  // 每个测试文件一个临时数据目录：app.getPath('userData') 指进去，
  // ConfigService 的 config.json 与 secureStorage 的 .secure-key / secure-storage.json 都落这里。
  userDataDir: null as string | null,
  // renderer ipcService.invokeDomain → 真实 host handler 的桥（beforeEach 由用例装配）。
  bridgeInvokeDomain: null as null | ((domain: string, action: string, payload?: unknown) => Promise<unknown>),
}));

vi.mock('../../../src/host/services/auth', () => ({
  getAuthService: () => ({
    getCurrentUser: () => mocks.currentUser,
    // 已验证会话 + isAdmin:false —— 与真实桌面非 admin 用户同档，get 走脱敏路径。
    hasVerifiedSession: () => true,
  }),
}));

vi.mock('../../../src/host/platform', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0-test'),
    getAppPath: () => process.cwd(),
    getPath: (name: string) => (mocks.userDataDir ? `${mocks.userDataDir}/${name}` : `/tmp/mock-electron-${name}`),
  },
  broadcastToRenderer: () => {},
}));

vi.mock('../../../src/host/services/providerIconAssets', () => ({
  saveProviderIconAsset: mocks.saveProviderIconAsset,
  resolveProviderIconAsset: mocks.resolveProviderIconAsset,
}));

// 只换掉 invokeDomain 的去向，其余 ipcService 成员保持真实实现（importOriginal 展开）。
vi.mock('../../../src/renderer/services/ipcService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/ipcService')>();
  const bridgedInvokeDomain = (domain: string, action: string, payload?: unknown): Promise<unknown> => {
    if (!mocks.bridgeInvokeDomain) {
      return Promise.reject(new Error('host bridge not ready: call startRealHost() first'));
    }
    return mocks.bridgeInvokeDomain(domain, action, payload);
  };
  return {
    ...actual,
    ipcService: { ...actual.ipcService, invokeDomain: bridgedInvokeDomain },
    default: { ...actual.ipcService, invokeDomain: bridgedInvokeDomain },
  };
});

vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));

type DomainHandler = (_: unknown, request: IPCRequest) => Promise<IPCResponse>;

function makeFakeIpc(): { handle: ReturnType<typeof vi.fn>; getHandler: () => DomainHandler } {
  const registry = new Map<string, DomainHandler>();
  const handle = vi.fn((channel: string, fn: DomainHandler) => {
    registry.set(channel, fn);
  });
  return {
    handle,
    getHandler: () => {
      const fn = registry.get(IPC_DOMAINS.SETTINGS);
      if (!fn) throw new Error('SETTINGS handler not registered');
      return fn;
    },
  };
}

let configService: ConfigService;
let persistedConfigPath: string;
let hostSettingsHandler: DomainHandler | null = null;

/** 启动真实 host 半边：真实 ConfigService（initialize 落盘默认配置）+ 真实 settings 路由表。 */
async function startRealHost(discoverModels?: (payload: unknown) => Promise<DiscoverModelsResult>): Promise<void> {
  const ipc = makeFakeIpc();
  configService = new ConfigService();
  // ConfigService 构造：configPath = app.getPath('userData')/config.json = <temp>/userData/config.json
  persistedConfigPath = path.join(mocks.userDataDir!, 'userData', 'config.json');
  await configService.initialize();
  registerSettingsHandlers(ipc as never, () => configService);
  hostSettingsHandler = ipc.getHandler();
  mocks.bridgeInvokeDomain = async (domain: string, action: string, payload?: unknown) => {
    if (domain === IPC_DOMAINS.PROVIDER && action === 'discover_models'
      && (payload as { provider: string }).provider === 'xiaomi' && discoverModels) {
      return discoverModels(payload);
    }
    if (domain !== IPC_DOMAINS.SETTINGS) {
      throw new Error(`test bridge only routes ${IPC_DOMAINS.SETTINGS}, got: ${domain}`);
    }
    const response = await hostSettingsHandler!({}, { action, payload } as IPCRequest);
    // 与 renderer invokeDomainRaw 同语义：!success → 抛 DomainInvokeError。
    if (!response?.success) {
      throw new DomainInvokeError(
        response?.error?.code || 'INTERNAL_ERROR',
        response?.error?.message || `${domain}:${action} failed`,
      );
    }
    return response.data;
  };
}

/** 组件外的新鲜 get：走同一条真实 handler（ensureModelConfigured 的调用形态）。 */
async function freshSettingsGet(): Promise<AppSettings> {
  return (await mocks.bridgeInvokeDomain!(IPC_DOMAINS.SETTINGS, 'get')) as AppSettings;
}

function Settings({
  initialProvider = 'deepseek',
  onModelChange,
}: { initialProvider?: ModelConfig['provider']; onModelChange?: (config: ModelConfig) => void }) {
  const [config, setConfig] = useState<ModelConfig>({ provider: initialProvider, model: getProviderInfo(initialProvider)!.defaultModel, apiKey: '', temperature: 0.7 });
  return <ModelSettings config={config} onChange={onModelChange ? (next) => { setConfig(next); onModelChange(next); } : setConfig} />;
}

const DEEPSEEK_KEY = 'sk-hermetic-save-flow-key';

function queryBadge(container: HTMLElement): Element | null {
  return Array.from(container.querySelectorAll('span')).find((span) => span.textContent === 'Unsaved changes') ?? null;
}

function findSaveButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((btn) => btn.textContent === 'Save configuration');
  if (!button) throw new Error('Save configuration button not found');
  return button;
}

/** 任务档位下拉：Select 原生 select 外包一层 div，档位 label 在再外层的档位块里。 */
function findProfileSelect(container: HTMLElement, label: string): HTMLSelectElement {
  const select = Array.from(container.querySelectorAll('select'))
    .find((sel) => sel.parentElement?.parentElement?.textContent?.includes(label));
  if (!select) throw new Error(`task profile select not found: ${label}`);
  return select as HTMLSelectElement;
}

beforeAll(() => {
  mocks.userDataDir = mkdtempSync(path.join(os.tmpdir(), 'model-settings-save-flow-'));
});

afterAll(() => {
  if (mocks.userDataDir) {
    rmSync(mocks.userDataDir, { recursive: true, force: true });
    mocks.userDataDir = null;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser = { id: 'local-owner', email: 'owner@test.dev', isAdmin: false };
  mocks.saveProviderIconAsset.mockResolvedValue({ icon: 'provider-icon://local/test.png', imageBytes: 5 });
  mocks.resolveProviderIconAsset.mockResolvedValue({
    icon: 'provider-icon://local/test.png',
    dataUrl: 'data:image/png;base64,aGVsbG8=',
  });
  mocks.bridgeInvokeDomain = null;
  hostSettingsHandler = null;
  // spy 包住真实 toast（调用照常落 store），断言「保存成功 / 失败」反馈通道真的跑过
  vi.spyOn(toast, 'success');
  vi.spyOn(toast, 'error');
  useAppStore.setState({ language: 'en', settingsModelFocus: null, settingsMemoryFocus: null });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetPolicyEngine();
  // 真实 ConfigService 单例 secureStorage 在文件内共享：清掉本文件写过的 key（apiKeyCache
  // + 持久 store 两处都要清，deleteApiKey 才覆盖）与落盘文件，让每条用例都从出厂默认起跑（顺序无关）。
  getSecureStorage().deleteApiKey('deepseek');
  // 第二条用例预置的 zhipu 可用 key 也要清（apiKeyCache 单例跨用例共享）
  getSecureStorage().deleteApiKey('zhipu');
  getSecureStorage().deleteApiKey('xiaomi');
  rmSync(path.join(mocks.userDataDir!, 'userData'), { recursive: true, force: true });
});

const xiaomiDefault = getProviderInfo('xiaomi')!.defaultModel;
const listedMiMo = 'mimo-v2.6-flash';
const endpointOnlyModel = 'gateway-chat';
const customEndpoint = 'https://subscription.test/v1';
const xiaomiKey = 'test-xiaomi-subscription-key';

function discoveredModels(...ids: string[]): DiscoverModelsResult {
  return {
    success: true,
    latencyMs: 5,
    models: ids.map((id) => ({
      id, label: id, capabilities: ['general'], supportsTool: true, supportsVision: false, supportsStreaming: true,
    })),
  };
}

async function saveXiaomiKey(baseUrl = customEndpoint, onModelChange?: (config: ModelConfig) => void) {
  const view = render(<Settings initialProvider="xiaomi" onModelChange={onModelChange} />);
  const keyInput = await waitFor(() => {
    expect(view.container.querySelector('[data-model-key-status]')?.textContent).toBe('Waiting for API Key');
    const input = view.container.querySelector<HTMLInputElement>('input[data-model-api-key]');
    expect(input).not.toBeNull();
    return input!;
  });
  const endpoint = view.getByPlaceholderText(getProviderEndpointForProtocol('xiaomi')!);
  fireEvent.change(endpoint, { target: { value: baseUrl } });
  fireEvent.change(keyInput, { target: { value: xiaomiKey } });
  fireEvent.click(findSaveButton(view.container));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Provider configuration saved'));
  return freshSettingsGet();
}

describe('ModelSettings custom endpoint promotion', () => {
  it.each([
    { name: 'prefers the first listed catalog model when the registry default is absent', ids: [endpointOnlyModel, listedMiMo], expected: listedMiMo },
    { name: 'keeps the listed registry default', ids: [listedMiMo, xiaomiDefault], expected: xiaomiDefault },
    { name: 'enables the first listed model when none are in the catalog', ids: [endpointOnlyModel, 'another-gateway-chat'], expected: endpointOnlyModel },
  ])('$name', async ({ ids, expected }) => {
    const discover = vi.fn().mockResolvedValue(discoveredModels(...ids));
    await startRealHost(discover);
    const onModelChange = vi.fn();
    const settings = await saveXiaomiKey(customEndpoint, onModelChange);
    expect(settings.models.providers.xiaomi.model).toBe(expected);
    expect(onModelChange).toHaveBeenLastCalledWith(expect.objectContaining({ model: expected }));
    expect(getSecureStorage().getApiKey('xiaomi')).toBe(xiaomiKey);
    if (expected !== endpointOnlyModel) expect(settings.models.providers.xiaomi.models?.[expected]).toBeUndefined();
    if (expected === listedMiMo) expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('MiMo v2.6 Flash'));
    expect(discover).toHaveBeenCalledExactlyOnceWith({
      provider: 'xiaomi', baseUrl: customEndpoint, protocol: 'openai', includeAllModels: true,
    });
    expect(settings.models.default).toBe('xiaomi');
    expect(settings.models.taskStrategy?.profiles.main).toMatchObject({ provider: 'xiaomi', model: expected });
    expect(buildRuntimeModelOptions(settings)).toContainEqual(expect.objectContaining({ provider: 'xiaomi', model: expected }));
  });

  it.each([
    {
      name: 'fails',
      discovery: { success: false, models: [], latencyMs: 5, error: { code: 'NETWORK_ERROR', message: 'Network unavailable' } },
      warning: 'Default model discovery failed during provider save',
      metadata: { provider: 'xiaomi', code: 'NETWORK_ERROR' },
    },
    {
      name: 'returns no models',
      discovery: discoveredModels(),
      warning: 'Default model discovery returned no models during provider save',
      metadata: { provider: 'xiaomi' },
    },
  ])('keeps the default and warns when discovery $name', async ({ discovery, warning, metadata }) => {
    const warn = vi.spyOn(console, 'warn');
    await startRealHost(vi.fn().mockResolvedValue(discovery));
    const settings = await saveXiaomiKey();
    expect(settings.models.default).toBe('xiaomi');
    expect(settings.models.providers.xiaomi.model).toBe(xiaomiDefault);
    expect(settings.models.taskStrategy?.profiles.main).toMatchObject({ provider: 'xiaomi', model: xiaomiDefault });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(warning), metadata);
  });

  it('keeps a saved model choice without discovering', async () => {
    const discover = vi.fn();
    await startRealHost(discover);
    await mocks.bridgeInvokeDomain!(IPC_DOMAINS.SETTINGS, 'set', {
      models: { providers: { xiaomi: { enabled: true, model: listedMiMo } } },
    });
    const settings = await saveXiaomiKey();
    expect(settings.models.providers.xiaomi.model).toBe(listedMiMo);
    expect(discover).not.toHaveBeenCalled();
  });

  it('discovers when the first key makes the current default provider available', async () => {
    const discover = vi.fn().mockResolvedValue(discoveredModels(listedMiMo));
    await startRealHost(discover);
    const before = await freshSettingsGet();
    await mocks.bridgeInvokeDomain!(IPC_DOMAINS.SETTINGS, 'set', {
      models: {
        default: 'xiaomi',
        defaultProvider: 'xiaomi',
        taskStrategy: {
          ...before.models.taskStrategy!,
          profiles: { ...before.models.taskStrategy!.profiles, main: { provider: 'xiaomi', model: xiaomiDefault } },
        },
      },
    });
    const settings = await saveXiaomiKey();
    expect(settings.models.providers.xiaomi.model).toBe(listedMiMo);
    expect(settings.models.taskStrategy?.profiles.main).toMatchObject({ provider: 'xiaomi', model: listedMiMo });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('skips the registry default when it is disabled', async () => {
    await startRealHost(vi.fn().mockResolvedValue(discoveredModels(xiaomiDefault, listedMiMo)));
    await mocks.bridgeInvokeDomain!(IPC_DOMAINS.SETTINGS, 'set', {
      models: { providers: { xiaomi: { enabled: true, models: { [xiaomiDefault]: { enabled: false } } } } },
    });
    const settings = await saveXiaomiKey();
    expect(settings.models.providers.xiaomi.model).toBe(listedMiMo);
    expect(settings.models.providers.xiaomi.models?.[xiaomiDefault]?.enabled).toBe(false);
  });

  it('preserves a task model selection saved while discovery is pending', async () => {
    const newMain = { provider: 'zhipu', model: getProviderInfo('zhipu')!.defaultModel, reasoningEffort: 'low', maxTokens: 4096 };
    await startRealHost(async () => {
      const pending = await freshSettingsGet();
      await mocks.bridgeInvokeDomain!(IPC_DOMAINS.SETTINGS, 'set', {
        models: {
          providers: { zhipu: { enabled: true, apiKey: 'test-zhipu-key-during-discovery' } },
          taskStrategy: {
            ...pending.models.taskStrategy!,
            profiles: { ...pending.models.taskStrategy!.profiles, main: newMain },
          },
        },
      });
      return discoveredModels(listedMiMo);
    });
    const settings = await saveXiaomiKey();
    expect(settings.models.providers.xiaomi.model).toBe(listedMiMo);
    expect(settings.models.taskStrategy?.profiles.main).toEqual(newMain);
  });

  it('keeps the official endpoint behavior', async () => {
    const discover = vi.fn();
    await startRealHost(discover);
    const settings = await saveXiaomiKey(getProviderEndpointForProtocol('xiaomi'));
    expect(settings.models.providers.xiaomi.model).toBe(xiaomiDefault);
    expect(discover).not.toHaveBeenCalled();
  });
});

describe('ModelSettings desktop save flow (real settings handler + real ConfigService)', () => {
  it('save clears the unsaved badge, persists the key in the real host, and the next-send predicate passes without remount', async () => {
    await startRealHost();

    // 保存前：出厂默认 longcat 没有 key —— ensureModelConfigured 的判据此刻应为 false。
    expect(hasConfiguredDefaultRuntimeModel(await freshSettingsGet())).toBe(false);
    expect(getSecureStorage().getApiKey('deepseek')).toBeUndefined();

    const view = render(<Settings />);
    const keyInput = await waitFor(() => {
      const input = view.container.querySelector<HTMLInputElement>('input[data-model-api-key]');
      expect(input).toBeTruthy();
      expect(input!.disabled).toBe(false);
      return input!;
    });
    expect(queryBadge(view.container)).toBeNull();
    await waitFor(() => expect(view.container.querySelector('[data-model-key-guide]')).not.toBeNull());
    expect(view.container.querySelector('[data-model-key-status]')?.textContent).toBe('Waiting for API Key');

    // type key → 徽标出现（staged-dirty 契约）
    fireEvent.change(keyInput, { target: { value: DEEPSEEK_KEY } });
    await waitFor(() => expect(queryBadge(view.container)).not.toBeNull());
    expect(view.container.querySelector('[data-model-key-status]')?.textContent).toBe('API Key not saved yet');
    expect(view.container.querySelector('[data-model-key-guide]')).not.toBeNull();
    expect(useToastStore.getState().toasts.some((t) => t.type === 'success')).toBe(false);

    const inputBeforeSave = view.container.querySelector('input[data-model-api-key]');
    const saveButton = findSaveButton(view.container);
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    // (a) 徽标消失（真实 set 成功后 setProviderFormDirty(false)）
    await waitFor(() => expect(queryBadge(view.container)).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('Provider configuration saved');

    // (b) 真实 ConfigService / secureStorage 已持有 key；config.json 落盘且无明文 key
    expect(getSecureStorage().getApiKey('deepseek')).toBe(DEEPSEEK_KEY);
    const persisted = JSON.parse(readFileSync(persistedConfigPath, 'utf-8')) as AppSettings;
    expect(persisted.models?.providers?.deepseek?.enabled).toBe(true);
    expect(persisted.models?.providers?.deepseek?.apiKeyConfigured).toBe(true);
    // ModelProviderSettings 自带 apiKey?: string 声明（src/shared/contract/settings.ts），直接断言 config.json 无明文 key
    expect(persisted.models?.providers?.deepseek?.apiKey).toBeUndefined();
    expect(configService.getSettings().models.providers.deepseek.apiKeyConfigured).toBe(true);

    // (c) 组件不动：下一次 send 前的真实 get（脱敏结果）让 hasConfiguredDefaultRuntimeModel 为 true
    const nextSendSettings = await freshSettingsGet();
    expect(hasConfiguredDefaultRuntimeModel(nextSendSettings)).toBe(true);
    expect(nextSendSettings.models.providers.deepseek).toMatchObject({ apiKeyConfigured: true, apiKeySource: 'saved' });
    expect(nextSendSettings.models.providers.deepseek.apiKey).toBeUndefined();
    expect(nextSendSettings.models.providers.longcat).toMatchObject({ apiKeyConfigured: false });
    await waitFor(() => expect(view.container.querySelector('[data-model-key-status]')?.textContent).toBe('API Key saved'));
    expect(view.container.querySelector('[data-model-key-guide]')).toBeNull();
    const options = Array.from(view.container.querySelectorAll<HTMLOptionElement>('option'));
    expect(options.some((option) => option.value.startsWith('longcat:::') && option.textContent?.includes('Key needed'))).toBe(true);
    expect(options.filter((option) => option.value.startsWith('deepseek:::')).every((option) => !option.textContent?.includes('Key needed'))).toBe(true);
    // 没有重载 / 重挂载：同一 input DOM 节点还在原位且保留表单值
    const inputAfterSave = view.container.querySelector<HTMLInputElement>('input[data-model-api-key]');
    expect(inputAfterSave).toBe(inputBeforeSave);
    expect(inputAfterSave?.value).toBe(DEEPSEEK_KEY);

    // (d) FB-1800：promote 不只切默认指针，还把 key-less 的任务主模型档接管到刚保存的
    // provider/model —— 下拉值与 models.default 一致、无 Key needed 标注，且不重挂载即刷新。
    const mainSelect = await waitFor(() => {
      const select = findProfileSelect(view.container, 'Main task model');
      expect(select.value).toBe(`deepseek:::${nextSendSettings.models.providers.deepseek.model}`);
      return select;
    });
    expect(nextSendSettings.models.default).toBe('deepseek');
    expect(nextSendSettings.models.taskStrategy?.profiles.main).toMatchObject({
      provider: 'deepseek',
      model: nextSendSettings.models.providers.deepseek.model,
    });
    expect(mainSelect.selectedOptions[0]?.textContent).not.toContain('Key needed');
    expect(inputAfterSave).toBe(view.container.querySelector('input[data-model-api-key]'));
  });

  it('a pasted-but-unsaved key keeps the DeepSeek row out of "✓ Key" until the real save lands', async () => {
    await startRealHost();
    const view = render(<Settings />);
    const keyInput = await waitFor(() => {
      const input = view.container.querySelector<HTMLInputElement>('input[data-model-api-key]');
      expect(input).toBeTruthy();
      return input!;
    });
    const findDeepSeekRow = () =>
      Array.from(view.container.querySelectorAll('aside button')).find((btn) => btn.textContent?.includes('DeepSeek'));
    await waitFor(() => expect(findDeepSeekRow()?.textContent).toBeTruthy());
    expect(findDeepSeekRow()?.textContent).not.toContain('✓ Key');

    // 粘贴 key 未点保存：行仍不算「已有 Key」，行尾与保存条同显「未保存」
    fireEvent.change(keyInput, { target: { value: DEEPSEEK_KEY } });
    await waitFor(() => expect(findDeepSeekRow()?.textContent).toContain('API Key not saved yet'));
    expect(findDeepSeekRow()?.textContent).not.toContain('✓ Key');
    expect(view.container.querySelector('[data-testid="provider-save-bar"]')?.textContent).toContain('API Key not saved yet');

    fireEvent.click(findSaveButton(view.container));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Provider configuration saved'));
    await waitFor(() => expect(findDeepSeekRow()?.textContent).toContain('✓ Key'));
    expect(view.container.querySelector('[data-testid="provider-save-bar"]')?.textContent).not.toContain('API Key not saved yet');
  });

  it('promote keeps a main task model slot that already points at a usable provider', async () => {
    await startRealHost();
    // 预置：zhipu 已有 key（可用），任务主模型档显式指向 zhipu——用户能用且选过的档位，
    // 保存 deepseek key 触发 promote（出厂默认 longcat 仍无 key）时不得被改写。
    const seeded = await freshSettingsGet();
    expect(seeded.models.providers.zhipu.apiKeyConfigured).toBe(false);
    await mocks.bridgeInvokeDomain!(IPC_DOMAINS.SETTINGS, 'set', {
      models: {
        providers: { zhipu: { ...seeded.models.providers.zhipu, apiKey: 'seed-zhipu-usable-key' } },
        taskStrategy: {
          ...seeded.models.taskStrategy!,
          profiles: { ...seeded.models.taskStrategy!.profiles, main: { ...seeded.models.taskStrategy!.profiles.fast } },
        },
      },
    });
    const seededStrategy = (await freshSettingsGet()).models.taskStrategy!;
    expect(seededStrategy.profiles.main).toMatchObject({ provider: 'zhipu', model: seededStrategy.profiles.fast.model });

    const view = render(<Settings />);
    const keyInput = await waitFor(() => {
      const input = view.container.querySelector<HTMLInputElement>('input[data-model-api-key]');
      expect(input).toBeTruthy();
      return input!;
    });
    const mainSelect = await waitFor(() => {
      const select = findProfileSelect(view.container, 'Main task model');
      expect(select.value).toBe(`zhipu:::${seededStrategy.profiles.fast.model}`);
      return select;
    });
    fireEvent.change(keyInput, { target: { value: DEEPSEEK_KEY } });
    fireEvent.click(findSaveButton(view.container));

    await waitFor(() => expect(queryBadge(view.container)).toBeNull());
    // promote 仍发生：默认指针切到 deepseek；但 main 档保持 zhipu 不动（同挂载组件 + 落库双证）
    const after = await freshSettingsGet();
    expect(after.models.default).toBe('deepseek');
    expect(after.models.taskStrategy?.profiles.main).toMatchObject({
      provider: 'zhipu',
      model: seededStrategy.profiles.fast.model,
    });
    expect(mainSelect.value).toBe(`zhipu:::${seededStrategy.profiles.fast.model}`);
    // main 没被接管时不出现「主任务模型已切换」的假提示（只有保存成功 toast）
    expect(toast.success).toHaveBeenCalledWith('Provider configuration saved');
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('was switched to'));
  });

  it('host set rejection keeps the unsaved badge and surfaces the error toast (no false saved)', async () => {
    await startRealHost();
    // host 半边 set 拒绝：updateSettings 抛错 → handleSet → IPC INTERNAL_ERROR → renderer 抛 DomainInvokeError
    const updateSettingsSpy = vi.spyOn(configService, 'updateSettings').mockRejectedValue(new Error('config disk write failed'));

    const view = render(<Settings />);
    const keyInput = await waitFor(() => {
      const input = view.container.querySelector<HTMLInputElement>('input[data-model-api-key]');
      expect(input).toBeTruthy();
      return input!;
    });
    fireEvent.change(keyInput, { target: { value: DEEPSEEK_KEY } });
    await waitFor(() => expect(queryBadge(view.container)).not.toBeNull());

    fireEvent.click(findSaveButton(view.container));

    // 错误 toast 走真实失败信息（穿过真实 handler 的 rejection）
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save configuration: config disk write failed'));
    // (a) 徽标仍在 —— 没有假「已保存」
    expect(queryBadge(view.container)).not.toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    // (b) host 没收下 key：secureStorage / config 都没有 deepseek 的痕迹
    expect(updateSettingsSpy).toHaveBeenCalledTimes(1);
    expect(getSecureStorage().getApiKey('deepseek')).toBeUndefined();
    // getSettings 对每个 provider 都注入 Boolean 形态的 apiKeyConfigured：没 key 即 false
    expect(configService.getSettings().models.providers.deepseek.apiKeyConfigured).toBe(false);
    // (c) 下一次 send 的判据依旧是 false（默认指针 longcat 仍无 key）
    expect(hasConfiguredDefaultRuntimeModel(await freshSettingsGet())).toBe(false);
    // (d) 列表行同样不认这个未落盘的草稿：DeepSeek 行仍无「✓ Key」
    const deepseekRow = Array.from(view.container.querySelectorAll('aside button'))
      .find((btn) => btn.textContent?.includes('DeepSeek'));
    expect(deepseekRow?.textContent).not.toContain('✓ Key');
    expect(deepseekRow?.textContent).toContain('API Key not saved yet');
  });
});
