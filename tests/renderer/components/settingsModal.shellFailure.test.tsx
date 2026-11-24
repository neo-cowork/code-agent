// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../../src/renderer/App';
import { languages } from '../../../src/renderer/i18n';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useServerConnectionStore } from '../../../src/renderer/stores/serverConnectionStore';
import * as serverConnectionMonitor from '../../../src/renderer/utils/serverConnectionMonitor';

vi.mock('../../../src/renderer/components/SettingsModal', () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ showSettings: false, language: 'zh' });
  useServerConnectionStore.getState().setStatus('ok');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['zh', 'en'] as const)('%s: a rejected Settings shell leaves the chat and outage banner mounted', async (language) => {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((media: string) => ({
    media, matches: false, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const t = languages[language];
  useAppStore.setState({ language });
  useServerConnectionStore.getState().setStatus('unavailable');
  const { container } = render(<App />);
  const composer = container.querySelector('[data-chat-input]');
  expect(composer).not.toBeNull();

  act(() => useAppStore.getState().setShowSettings(true));

  const message = await screen.findByText(t.settings.pageLoadFailed);
  const notice = within(message.closest('[role=status]') as HTMLElement);
  expect(notice.getByText(t.serverConnection.unavailableHintWeb)).toBeTruthy();
  const retry = vi.spyOn(serverConnectionMonitor, 'retryNow');
  fireEvent.click(notice.getByRole('button', { name: t.settings.reloadPage }));
  expect(retry).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-chat-input]')).toBe(composer);
  expect(composer?.closest('[inert]')).toBeNull();
  expect(screen.getByTestId('server-connection-banner').textContent).toContain(t.serverConnection.unavailable);
  expect(container.textContent).not.toMatch(/任务执行失败|Task failed|TypeError|Failed to fetch dynamically imported module/);
  expect(screen.queryByText(t.errorBoundary.viewDetails)).toBeNull();
  expect(container.querySelector('pre')).toBeNull();

  fireEvent.click(notice.getByRole('button', { name: t.common.close }));
  expect(screen.queryByText(t.settings.pageLoadFailed)).toBeNull();
  expect(container.querySelector('[data-chat-input]')).toBe(composer);
});
