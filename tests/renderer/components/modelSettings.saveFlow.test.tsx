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
import { hasConfiguredDefaultRuntimeModel } from '../../../src/shared/modelRuntime';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { toast, useToastStore } from '../../../src/renderer/hooks/useToast';
import { DomainInvokeError } from '../../../src/renderer/services/ipcService';
import { ModelSettings } from '../../../src/renderer/components/features/settings/tabs/ModelSettings';
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
async function startRealHost(): Promise<void> {
  const ipc = makeFakeIpc();
  configService = new ConfigService();
  // ConfigService 构造：configPath = app.getPath('userData')/config.json = <temp>/userData/config.json
  persistedConfigPath = path.join(mocks.userDataDir!, 'userData', 'config.json');
  await configService.initialize();
  registerSettingsHandlers(ipc as never, () => configService);
  hostSettingsHandler = ipc.getHandler();
  mocks.bridgeInvokeDomain = async (domain: string, action: string, payload?: unknown) => {
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

function Settings({ initialProvider = 'deepseek' as ModelConfig['provider'] }: { initialProvider?: ModelConfig['provider'] }) {
  const [config, setConfig] = useState<ModelConfig>({ provider: initialProvider, model: 'deepseek-chat', apiKey: '', temperature: 0.7 });
  return <ModelSettings config={config} onChange={setConfig} />;
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
  rmSync(path.join(mocks.userDataDir!, 'userData'), { recursive: true, force: true });
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

    // type key → 徽标出现（staged-dirty 契约）
    fireEvent.change(keyInput, { target: { value: DEEPSEEK_KEY } });
    await waitFor(() => expect(queryBadge(view.container)).not.toBeNull());
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
    expect((persisted.models?.providers?.deepseek as Record<string, unknown> | undefined)?.apiKey).toBeUndefined();
    expect(configService.getSettings().models.providers.deepseek.apiKeyConfigured).toBe(true);

    // (c) 组件不动：下一次 send 前的真实 get（脱敏结果）让 hasConfiguredDefaultRuntimeModel 为 true
    const nextSendSettings = await freshSettingsGet();
    expect(hasConfiguredDefaultRuntimeModel(nextSendSettings)).toBe(true);
    // 没有重载 / 重挂载：同一 input DOM 节点还在原位且保留表单值
    const inputAfterSave = view.container.querySelector('input[data-model-api-key]');
    expect(inputAfterSave).toBe(inputBeforeSave);
    expect(inputAfterSave?.value).toBe(DEEPSEEK_KEY);
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
  });
});
