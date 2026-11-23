// @vitest-environment jsdom
// 语言本地快照（code-agent-language）：后端设置仍是真源，localStorage 只是首帧取值。
// 每条用例先摆 localStorage 再 resetModules + 动态 import，模拟一次真实页面加载时
// appStore 初始态的读取顺序；组件与 store 走同一份新鲜模块实例。
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLanguage, en, zh } from '../../../src/renderer/i18n';

vi.mock('../../../src/renderer/services/ipcService', async (original) => ({
  ...await original<typeof import('../../../src/renderer/services/ipcService')>(),
  default: {
    ...(await original<typeof import('../../../src/renderer/services/ipcService')>()).default,
    on: vi.fn(() => vi.fn()),
    isAvailable: () => false,
  },
}));

const invoke = vi.fn();
const STORAGE_KEY = 'code-agent-language';

async function importFresh() {
  vi.resetModules();
  const [appStoreModule, authStoreModule, sidebarModule, modelSlotModule] = await Promise.all([
    import('../../../src/renderer/stores/appStore'),
    import('../../../src/renderer/stores/authStore'),
    import('../../../src/renderer/components/features/sidebar/SidebarAccountStatus'),
    import('../../../src/renderer/components/StatusBar/ModelSlot'),
  ]);
  return {
    useAppStore: appStoreModule.useAppStore,
    useAuthStore: authStoreModule.useAuthStore,
    initializeAuthStore: authStoreModule.initializeAuthStore,
    SidebarAccountStatus: sidebarModule.SidebarAccountStatus,
    ModelSlot: modelSlotModule.ModelSlot,
  };
}

beforeEach(() => {
  invoke.mockReset().mockRejectedValue(new Error('Network unavailable'));
  Object.defineProperty(window, 'domainAPI', { configurable: true, value: { invoke } });
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('stored language snapshot', () => {
  it('saved en keeps startup placeholders English while settings load is unreachable', async () => {
    localStorage.setItem(STORAGE_KEY, 'en');
    const { useAppStore, useAuthStore, initializeAuthStore, SidebarAccountStatus, ModelSlot } = await importFresh();
    expect(useAppStore.getState().language).toBe('en');
    useAuthStore.setState({ statusLoadFailed: false, isAuthenticated: false, user: null, isLoading: true });
    useAppStore.setState({ settingsLoaded: false });
    await initializeAuthStore();
    render(
      <>
        <SidebarAccountStatus />
        <ModelSlot currentModel={useAppStore.getState().modelConfig.model} />
      </>,
    );
    expect(screen.getByTestId('sidebar-account-unreachable').textContent)
      .toContain('Can’t reach the service right now. Account status is unconfirmed.');
    expect(screen.getByTestId('model-loading').textContent).toContain('Loading model…');
    expect(screen.queryByText(zh.sidebar.accountUnreachable)).toBeNull();
    expect(screen.queryByText(zh.sidebar.modelLoading)).toBeNull();
  });

  it('no saved language falls back to defaultLanguage and shows zh placeholders', async () => {
    const { useAppStore, useAuthStore, initializeAuthStore, SidebarAccountStatus, ModelSlot } = await importFresh();
    expect(useAppStore.getState().language).toBe(defaultLanguage);
    useAuthStore.setState({ statusLoadFailed: false, isAuthenticated: false, user: null, isLoading: true });
    useAppStore.setState({ settingsLoaded: false });
    await initializeAuthStore();
    render(
      <>
        <SidebarAccountStatus />
        <ModelSlot currentModel={useAppStore.getState().modelConfig.model} />
      </>,
    );
    expect(screen.getByText(zh.sidebar.accountUnreachable)).toBeTruthy();
    expect(screen.getByText(zh.sidebar.modelLoading)).toBeTruthy();
  });

  it.each(['fr', 'zh-cn', ''])('invalid saved value %j falls back to defaultLanguage', async (saved) => {
    localStorage.setItem(STORAGE_KEY, saved);
    const { useAppStore } = await importFresh();
    expect(useAppStore.getState().language).toBe(defaultLanguage);
  });

  it('server language zh overrides saved en, switches the UI and rewrites the snapshot', async () => {
    localStorage.setItem(STORAGE_KEY, 'en');
    const { useAppStore, useAuthStore, initializeAuthStore, SidebarAccountStatus } = await importFresh();
    expect(useAppStore.getState().language).toBe('en');
    useAuthStore.setState({ statusLoadFailed: false, isAuthenticated: false, user: null, isLoading: true });
    await initializeAuthStore();
    render(<SidebarAccountStatus />);
    expect(screen.getByText(en.sidebar.accountUnreachable)).toBeTruthy();
    // App.tsx loadSettings 路径：settings 加载成功时调用同一个公开 setLanguage
    act(() => useAppStore.getState().setLanguage('zh'));
    expect(useAppStore.getState().language).toBe('zh');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('zh');
    expect(screen.getByText(zh.sidebar.accountUnreachable)).toBeTruthy();
    expect(screen.queryByText(en.sidebar.accountUnreachable)).toBeNull();
  });

  it('setLanguage persists the choice for the next page load (AppearanceSettings path)', async () => {
    const { useAppStore } = await importFresh();
    act(() => useAppStore.getState().setLanguage('en'));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('en');
    const nextLoad = await importFresh();
    expect(nextLoad.useAppStore.getState().language).toBe('en');
  });
});
