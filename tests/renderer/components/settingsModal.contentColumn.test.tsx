// @vitest-environment jsdom
// ============================================================================
// FB-215：设置页内容列左锚定（mr-auto 而非 mx-auto），宽 tab（model，max-w-6xl）
// 与窄 tab（search，max-w-4xl）切换时内容左缘不再跳动。
// 容器带 data-testid="settings-content-column" 供编排者截图量左缘。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../../src/renderer/components/features/settings/SettingsSearch', () => ({
  SettingsSearch: () => null,
}));

vi.mock('../../../src/renderer/slots/productSlotHosts', () => ({
  SettingsSectionSlotHost: () => null,
}));

vi.mock('../../../src/renderer/components/composites/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

vi.mock('../../../src/renderer/components/UpdateNotification', () => ({
  UpdateNotification: () => null,
}));

vi.mock('../../../src/renderer/components/features/settings/tabs/ModelSettings', () => ({
  ModelSettings: () => <div data-testid="stub-model-settings" />,
}));

vi.mock('../../../src/renderer/components/features/settings/tabs/SearchSettings', () => ({
  SearchSettings: () => <div data-testid="stub-search-settings" />,
}));

vi.mock('../../../src/renderer/components/features/settings/tabs/AboutSettings', () => {
  throw new TypeError('Importing a module script failed.');
});

vi.mock('@shared/keybindings/defaults', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/shared/keybindings/defaults')>(),
  getCurrentKeybindingPlatform: () => 'darwin',
}));

import { ErrorBoundary } from '../../../src/renderer/components/ErrorBoundary';
import { languages } from '../../../src/renderer/i18n';
import { useServerConnectionStore } from '../../../src/renderer/stores/serverConnectionStore';
import * as serverConnectionMonitor from '../../../src/renderer/utils/serverConnectionMonitor';
import { SettingsModal } from '../../../src/renderer/components/features/settings/SettingsModal';
import { useAppStore } from '../../../src/renderer/stores/appStore';

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh', settingsInitialTab: null });
  useServerConnectionStore.getState().setStatus('ok');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SettingsModal 内容列左锚定（FB-215）', () => {
  it('宽 tab（model）：内容列 mr-auto、不含 mx-auto，带 data-testid', () => {
    useAppStore.setState({ settingsInitialTab: 'model' });
    render(<SettingsModal />);

    const column = screen.getByTestId('settings-content-column');
    expect(column.classList.contains('mr-auto')).toBe(true);
    expect(column.classList.contains('mx-auto')).toBe(false);
    expect(column.classList.contains('max-w-6xl')).toBe(true);
  });

  it('窄 tab（search）：内容列 mr-auto、不含 mx-auto', () => {
    useAppStore.setState({ settingsInitialTab: 'search' });
    render(<SettingsModal />);

    const column = screen.getByTestId('settings-content-column');
    expect(column.classList.contains('mr-auto')).toBe(true);
    expect(column.classList.contains('mx-auto')).toBe(false);
    expect(column.classList.contains('max-w-4xl')).toBe(true);
  });
});

describe('SettingsModal service outage', () => {
  it.each(['zh', 'en'] as const)('%s: shows the unavailable banner inside Settings on web', (language) => {
    useAppStore.setState({ language, settingsInitialTab: 'search' });
    useServerConnectionStore.getState().setStatus('unavailable');
    render(<SettingsModal />);

    const banner = within(screen.getByTestId('settings-panel')).getByTestId('server-connection-banner');
    expect(banner.textContent).toContain(languages[language].serverConnection.unavailableHintWeb);
  });

  it.each(['zh', 'en'] as const)('%s: Settings banner shows the macOS reload shortcut in Tauri', (language) => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    useAppStore.setState({ language, settingsInitialTab: 'search' });
    useServerConnectionStore.getState().setStatus('unavailable');
    render(<SettingsModal />);

    const panel = screen.getByTestId('settings-panel');
    const banner = within(panel).getByTestId('server-connection-banner');
    expect(banner.textContent).toContain(language === 'zh' ? '⌘R 重新载入' : 'press ⌘R to reload');
    expect(banner.classList.contains('pl-[92px]')).toBe(true);
    expect(panel.classList.contains('pt-7')).toBe(false);
  });

  it.each(['zh', 'en'] as const)('%s: a rejected lazy tab stays within Settings and other tabs still open', async (language) => {
    const t = languages[language];
    useAppStore.setState({ language, settingsInitialTab: 'search' });
    useServerConnectionStore.getState().setStatus('unavailable');
    render(<ErrorBoundary><SettingsModal /></ErrorBoundary>);
    await screen.findByTestId('stub-search-settings');

    const panel = within(screen.getByTestId('settings-panel'));
    fireEvent.click(panel.getByRole('button', { name: t.settings.tabs.about }));
    const main = within(panel.getByRole('main'));
    expect(await main.findByText(t.settings.pageLoadFailed)).toBeTruthy();
    expect(main.getByText(t.serverConnection.unavailableHintWeb)).toBeTruthy();
    const retry = vi.spyOn(serverConnectionMonitor, 'retryNow');
    fireEvent.click(main.getByRole('button', { name: t.settings.reloadPage }));
    expect(retry).toHaveBeenCalledOnce();
    expect(main.getByText(t.settings.pageLoadFailed)).toBeTruthy();
    expect(panel.getByTestId('server-connection-banner')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/TypeError|Importing a module|任务执行失败|Task failed/);
    expect(document.querySelector('pre')).toBeNull();

    fireEvent.click(panel.getByRole('button', { name: t.settings.tabs.search }));
    expect(await main.findByTestId('stub-search-settings')).toBeTruthy();
    expect(main.queryByText(t.settings.pageLoadFailed)).toBeNull();
  });
});
