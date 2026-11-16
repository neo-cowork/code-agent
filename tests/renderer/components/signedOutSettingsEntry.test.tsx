// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarSignedOutFooter } from '../../../src/renderer/components/features/sidebar/SidebarSignedOutFooter';
import { AuthModal } from '../../../src/renderer/components/AuthModal';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import ipcService from '../../../src/renderer/services/ipcService';
import { DEFAULT_PROVIDER } from '../../../src/shared/constants';
import { resolveConfiguredDefaultProvider } from '../../../src/shared/modelDefaults';
import { getLocalizedProviderDisplayName } from '../../../src/renderer/i18n/providerDisplay';
import { languages } from '../../../src/renderer/i18n';

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invoke: vi.fn(), invokeDomain: vi.fn() } }));
const emptySettings = { models: { default: DEFAULT_PROVIDER, providers: {} } };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.mocked(ipcService.invokeDomain).mockReset().mockResolvedValue(emptySettings);
  useToastStore.setState({ toasts: [] });
  useAuthStore.setState({ isAuthenticated: false, user: null, showAuthModal: false, isLoading: false, error: null });
  useAppStore.setState({ language: 'zh', showSettings: false, settingsInitialTab: undefined, settingsModelFocus: null });
});

describe('signed-out settings entries', () => {
  it.each([
    ['zh', '登录', '设置'],
    ['en', 'Sign in', 'Settings'],
  ] as const)('shows both footer actions in %s and opens Settings without signing in', (language, signIn, settings) => {
    useAppStore.setState({ language });
    render(<SidebarSignedOutFooter />);
    fireEvent.click(screen.getByRole('button', { name: signIn }));
    expect(useAuthStore.getState().showAuthModal).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: settings }));
    expect(useAppStore.getState().showSettings).toBe(true);
    expect(useAuthStore.getState().showAuthModal).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it.each([
    ['zh', '先不登录，去配置模型/通道', DEFAULT_PROVIDER],
    ['en', 'Skip sign-in and set up a model or channel', DEFAULT_PROVIDER],
    ['zh', '先不登录，去配置模型/通道', 'zhipu'],
    ['en', 'Skip sign-in and set up a model or channel', 'zhipu'],
  ] as const)('exits the auth dialog to the Model tab in %s for %s / %s', async (language, label, provider) => {
    const settings = { models: { default: provider, providers: {} } };
    vi.mocked(ipcService.invokeDomain).mockResolvedValue(settings);
    const expectedProvider = resolveConfiguredDefaultProvider(settings.models, DEFAULT_PROVIDER);
    useAppStore.setState({ language });
    useAuthStore.setState({ showAuthModal: true });
    render(<AuthModal />);
    act(() => { fireEvent.click(screen.getByRole('button', { name: label })); });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(useAppStore.getState().showSettings).toBe(true));
    expect(useAppStore.getState().settingsInitialTab).toBe('model');
    expect(useAppStore.getState().settingsModelFocus?.provider).toBe(expectedProvider);
    const providerName = getLocalizedProviderDisplayName(expectedProvider, language)!;
    const message = useToastStore.getState().toasts[0]?.message;
    expect(message).toBe(languages[language].modelSetup.missingApiKey.replace('{provider}', providerName));
    expect(message).toContain(providerName);
    if (language === 'en') expect(message).not.toMatch(/[\u3400-\u9fff]/);
    if (language === 'zh') expect(message?.replace(providerName, '')).not.toMatch(/[A-Za-z]/);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it.each(['default', 'other'] as const)('keeps plain Model settings when a usable %s model exists', async (kind) => {
    vi.mocked(ipcService.invokeDomain).mockResolvedValue({
      models: { default: kind === 'default' ? DEFAULT_PROVIDER : 'zhipu', providers: { [DEFAULT_PROVIDER]: { enabled: true, apiKeyConfigured: true } } },
    });
    useAuthStore.setState({ showAuthModal: true });
    render(<AuthModal />);
    fireEvent.click(screen.getByRole('button', { name: languages.zh.sidebar.skipSignInSetup }));
    await waitFor(() => expect(useAppStore.getState().showSettings).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useAppStore.getState().settingsInitialTab).toBe('model');
    expect(useAppStore.getState().settingsModelFocus).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('opens Model settings and logs when the settings read rejects', async () => {
    const error = new Error('settings unavailable');
    vi.mocked(ipcService.invokeDomain).mockRejectedValue(error);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    useAuthStore.setState({ showAuthModal: true });
    render(<AuthModal />);
    fireEvent.click(screen.getByRole('button', { name: languages.zh.sidebar.skipSignInSetup }));
    await waitFor(() => expect(useAppStore.getState().showSettings).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useAppStore.getState().settingsInitialTab).toBe('model');
    expect(useAppStore.getState().settingsModelFocus).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Settings read failed while checking model setup'), { error });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
