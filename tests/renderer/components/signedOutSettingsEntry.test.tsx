// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SidebarSignedOutFooter } from '../../../src/renderer/components/features/sidebar/SidebarSignedOutFooter';
import { AuthModal } from '../../../src/renderer/components/AuthModal';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

afterEach(() => cleanup());
beforeEach(() => {
  useAuthStore.setState({ isAuthenticated: false, user: null, showAuthModal: false, isLoading: false, error: null });
  useAppStore.setState({ language: 'zh', showSettings: false, settingsInitialTab: undefined });
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
    ['zh', '先不登录，去配置模型/通道'],
    ['en', 'Skip sign-in and set up a model or channel'],
  ] as const)('exits the auth dialog to the Model tab in %s', (language, label) => {
    useAppStore.setState({ language });
    useAuthStore.setState({ showAuthModal: true });
    render(<AuthModal />);
    act(() => { fireEvent.click(screen.getByRole('button', { name: label })); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useAppStore.getState().showSettings).toBe(true);
    expect(useAppStore.getState().settingsInitialTab).toBe('model');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
