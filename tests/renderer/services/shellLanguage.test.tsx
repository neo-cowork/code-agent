// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useShellLanguage } from '../../../src/renderer/hooks/useShellLanguage';

const invoke = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  useAppStore.getState().setLanguage('zh');
  vi.clearAllMocks();
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('shell language through the production hook, app store and native facade', () => {
  it('syncs the hydrated startup language and each language change exactly once', () => {
    const { rerender, unmount } = renderHook(({ loaded }) => useShellLanguage(loaded), {
      initialProps: { loaded: false },
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    expect(invoke).not.toHaveBeenCalled();
    act(() => useAppStore.getState().setLanguage('en'));
    expect(invoke).not.toHaveBeenCalled();
    rerender({ loaded: true });
    expect(invoke.mock.calls).toEqual([['set_shell_language', { lang: 'en' }]]);
    act(() => useAppStore.getState().setLanguage('zh'));
    expect(invoke.mock.calls).toEqual([
      ['set_shell_language', { lang: 'en' }],
      ['set_shell_language', { lang: 'zh' }],
    ]);
    act(() => useAppStore.getState().setLanguage('zh'));
    rerender({ loaded: true });
    expect(invoke).toHaveBeenCalledTimes(2);
    process.stdout.write(`window.__TAURI_INTERNALS__.invoke calls: ${JSON.stringify(invoke.mock.calls)}\n`);
    unmount();
    act(() => useAppStore.getState().setLanguage('en'));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('deduplicates the startup sync under StrictMode effect replay', () => {
    renderHook(() => useShellLanguage(true), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    expect(invoke.mock.calls).toEqual([['set_shell_language', { lang: 'zh' }]]);
    process.stdout.write(`StrictMode startup invoke calls: ${JSON.stringify(invoke.mock.calls)}\n`);
  });

  it('does not invoke native commands in a web build', () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    renderHook(() => useShellLanguage(true));
    act(() => useAppStore.getState().setLanguage('en'));
    act(() => useAppStore.getState().setLanguage('zh'));
    expect(invoke).not.toHaveBeenCalled();
    process.stdout.write(`web build invoke calls: ${JSON.stringify(invoke.mock.calls)}\n`);
  });
});
