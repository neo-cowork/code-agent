// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthModal } from '../../../src/renderer/components/AuthModal';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { languages } from '../../../src/renderer/i18n';

beforeEach(() => {
  useAuthStore.setState({ showAuthModal: true, isAuthenticated: false, isLoading: false, error: null });
  window.domainAPI = { invoke: vi.fn(async () => ({ success: true, data: { success: false } })) } as typeof window.domainAPI;
});
afterEach(() => { cleanup(); window.domainAPI = undefined; });

describe('AuthModal language', () => {
  it.each(['en', 'zh'] as const)('localises sign-in, sign-up and reset including success: %s', async (language) => {
    useAppStore.setState({ language });
    const text = languages[language].authModal;
    const reset = vi.spyOn(useAuthStore.getState(), 'resetPassword').mockResolvedValue(true);
    render(<AuthModal />);
    expect(screen.getByRole('dialog', { name: text.signIn })).toBeTruthy();
    expect(screen.getByPlaceholderText(text.passwordPlaceholder)).toBeTruthy();
    expect(screen.getByText(text.rememberPassword)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text.signUp }));
    expect(screen.getByText(text.inviteHint)).toBeTruthy();
    expect(screen.getByPlaceholderText(text.invitePlaceholder)).toBeTruthy();
    if (language === 'en') expect(screen.getByRole('dialog').textContent).not.toMatch(/\p{Script=Han}/u);
    fireEvent.click(screen.getAllByRole('button', { name: text.signIn })[0]);
    fireEvent.click(screen.getByRole('button', { name: text.forgotPassword }));
    expect(screen.getByRole('dialog', { name: text.resetTitle })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(text.emailPlaceholder), { target: { value: 'reader@example.test' } });
    fireEvent.submit(screen.getByRole('button', { name: text.sendResetLink }).closest('form')!);
    await waitFor(() => expect(screen.getByText(text.resetSent)).toBeTruthy());
    expect(screen.getByRole('dialog').textContent).toContain(text.resetLinkHint);
    if (language === 'en') expect(screen.getByRole('dialog').textContent).not.toMatch(/\p{Script=Han}/u);
    reset.mockRestore();
  });

  it.each(['en', 'zh'] as const)('uses localised store fallbacks for failed sign-in and sign-up: %s', async (language) => {
    useAppStore.setState({ language });
    render(<AuthModal />);
    await actOnFailure(() => useAuthStore.getState().signInWithEmail('reader@example.test', 'not-a-secret'));
    expect(screen.getByText(languages[language].authModal.signInFailed)).toBeTruthy();
    await actOnFailure(() => useAuthStore.getState().signUpWithEmail('reader@example.test', 'not-a-secret', 'INVITE'));
    expect(screen.getByText(languages[language].authModal.signUpFailed)).toBeTruthy();
  });
});

async function actOnFailure(action: () => Promise<boolean>) {
  const { act } = await import('@testing-library/react');
  await act(async () => { expect(await action()).toBe(false); });
}
