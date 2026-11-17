// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEB_SERVER_CONNECTION_MONITOR as timing } from '../../../src/shared/constants';
import { ServerConnectionBanner } from '../../../src/renderer/components/ServerConnectionBanner';
import { useServerConnectionStore } from '../../../src/renderer/stores/serverConnectionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { reportServerUnreachable, retryNow } from '../../../src/renderer/utils/serverConnectionMonitor';
import { serverConnectionEn, serverConnectionZh } from '../../../src/renderer/i18n/serverConnection';

const fetchMock = vi.fn();

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function renderBannerAtPlatform(
  platform: 'darwin' | 'linux',
  status: 'recovering' | 'unavailable',
) {
  vi.resetModules();
  vi.doMock('@shared/keybindings/defaults', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/shared/keybindings/defaults')>();
    return { ...actual, getCurrentKeybindingPlatform: () => platform };
  });
  const { ServerConnectionBanner: Banner } = await import('../../../src/renderer/components/ServerConnectionBanner');
  const { useServerConnectionStore: platformStore } = await import('../../../src/renderer/stores/serverConnectionStore');
  act(() => platformStore.getState().setStatus(status));
  render(<Banner />);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockRejectedValue(new TypeError('Load failed'));
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  useServerConnectionStore.getState().setStatus('ok');
});

afterEach(async () => {
  // Let the public success path stop the singleton monitor before the next case.
  fetchMock.mockResolvedValue({ ok: true });
  await advance(timing.PROBE_INTERVAL_MS + timing.PROBE_TIMEOUT_MS);
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.doUnmock('@shared/keybindings/defaults');
  vi.resetModules();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('Retry feedback through the real banner and monitor', () => {
  it.each(['zh', 'en'] as const)('%s: checking is immediate, disabled; failure persists until success', async (language) => {
    useAppStore.setState({ language });
    const copy = language === 'zh' ? serverConnectionZh.serverConnection : serverConnectionEn.serverConnection;
    render(<ServerConnectionBanner />);
    act(() => reportServerUnreachable());
    await advance(timing.UNAVAILABLE_AFTER_MS);
    expect(screen.getByRole('status').textContent).toContain(copy.unavailableHintTauri);
    expect(screen.getByRole('status').textContent).not.toMatch(/系统弹窗|system dialog/);

    let rejectProbe: (error: Error) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectProbe = reject; }));
    fireEvent.click(screen.getByRole('button', { name: copy.retry }));
    const checking = screen.getByRole('button', { name: copy.checking }) as HTMLButtonElement;
    expect(checking.disabled).toBe(true);
    expect(useServerConnectionStore.getState().retryState).toBe('checking');
    const calls = fetchMock.mock.calls.length;
    fireEvent.click(checking);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    await act(async () => rejectProbe(new TypeError('Load failed')));
    expect(screen.getByRole('status').textContent).toContain(copy.retryFailed);
    expect((screen.getByRole('button', { name: copy.retry }) as HTMLButtonElement).disabled).toBe(false);
    await advance(timing.PROBE_INTERVAL_MS);
    expect(screen.getByRole('status').textContent).toContain(copy.retryFailed);

    fetchMock.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: copy.retry }));
    await advance(0);
    expect(screen.queryByRole('status')).toBeNull();
    expect(useServerConnectionStore.getState().retryState).toBe('idle');
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    act(() => reportServerUnreachable());
    await advance(timing.UNAVAILABLE_AFTER_MS);
    expect(screen.getByRole('status').textContent).not.toContain(copy.retryFailed);
  });

  it('ignores repeated retryNow calls while the banner is checking', async () => {
    useAppStore.setState({ language: 'en' });
    render(<ServerConnectionBanner />);
    act(() => reportServerUnreachable());
    await advance(timing.UNAVAILABLE_AFTER_MS);

    let rejectProbe: (error: Error) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectProbe = reject; }));
    const callsBeforeRetry = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: serverConnectionEn.serverConnection.retry }));
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRetry + 1);
    expect((screen.getByRole('button', { name: serverConnectionEn.serverConnection.checking }) as HTMLButtonElement).disabled).toBe(true);

    act(() => { retryNow(); retryNow(); });
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRetry + 1);
    await act(async () => rejectProbe(new TypeError('Load failed')));
    expect(screen.getByRole('status').textContent).toContain(serverConnectionEn.serverConnection.retryFailed);
  });

  it('new keys have zh/en parity', () => {
    expect(Object.keys(serverConnectionZh.serverConnection).sort()).toEqual(Object.keys(serverConnectionEn.serverConnection).sort());
  });
});

describe('macOS traffic light safe area', () => {
  it.each(['recovering', 'unavailable'] as const)('Tauri %s: inset, minimum height and drag region', async (status) => {
    await renderBannerAtPlatform('darwin', status);
    const banner = screen.getByTestId('server-connection-banner');
    expect(banner.classList.contains('pl-[92px]')).toBe(true);
    expect(banner.classList.contains('min-h-12')).toBe(true);
    expect(banner.getAttribute('data-tauri-drag-region')).toBe('deep');
  });

  it.each(['recovering', 'unavailable'] as const)('web %s: no inset, Tauri minimum height or drag region', async (status) => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    await renderBannerAtPlatform('darwin', status);
    const banner = screen.getByTestId('server-connection-banner');
    expect(banner.classList.contains('pl-[92px]')).toBe(false);
    expect(banner.classList.contains('min-h-12')).toBe(false);
    expect(banner.hasAttribute('data-tauri-drag-region')).toBe(false);
  });

  it('non-darwin Tauri keeps the minimum height without the macOS inset', async () => {
    await renderBannerAtPlatform('linux', 'recovering');
    const banner = screen.getByTestId('server-connection-banner');
    expect(banner.classList.contains('min-h-12')).toBe(true);
    expect(banner.classList.contains('pl-[92px]')).toBe(false);
    expect(banner.getAttribute('data-tauri-drag-region')).toBe('deep');
  });
});
