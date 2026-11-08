// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UpdateSettings } from '../../../src/renderer/components/features/settings/tabs/UpdateSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import ipcService from '../../../src/renderer/services/ipcService';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import type { DesktopShellDiagnostics, UpdateInfo } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(), invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
  isTauriMode: () => true,
}));
vi.mock('../../../src/renderer/utils/tauriUpdater', () => ({
  tauriGetCurrentVersion: vi.fn().mockResolvedValue('0.16.75'),
  tauriCheckForUpdate: vi.fn(),
  tauriInstallUpdate: vi.fn(),
  tauriOpenUpdateUrl: vi.fn(),
}));
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  getNativeDesktopPermissionStatus: vi.fn().mockResolvedValue(null),
  isNativeDesktopAvailable: () => false,
}));

const updateInfo: UpdateInfo = { hasUpdate: false, currentVersion: '0.16.75' };

function desktopShellDiagnostics(): DesktopShellDiagnostics {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-24T00:00:00.000Z',
    app: {
      version: '0.16.102',
      mode: 'tauri',
      dataDir: '/tmp/neo-data',
      webPort: 8180,
      pid: 100,
    },
    boot: {
      stage: 'window-navigated',
      pid: 100,
      webServerPid: 200,
      healthMatchedBootToken: true,
    },
    webServer: {
      url: 'http://localhost:8180',
      health: 'ok',
      pid: 200,
      serverRoot: '/app/dist/web',
    },
    renderer: null,
    resources: [
      {
        id: 'better-sqlite3-native',
        label: 'better-sqlite3 native module',
        kind: 'native-module',
        path: '/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
        required: true,
        status: 'present',
      },
      {
        id: 'required-resource',
        label: 'Required resource',
        kind: 'resource',
        path: '/app/dist/required.dat',
        required: true,
        status: 'missing',
      },
    ],
    runtimeAssets: null,
    nativePermissions: null,
    rendererBundle: null,
    issues: [],
  };
}

beforeEach(() => {
  vi.mocked(ipcService.invoke).mockResolvedValue(undefined as never);
  vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => (
    action === 'desktopShell' ? desktopShellDiagnostics() : null
  ));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.setState({ language: 'zh', developerMode: false });
});

describe.each([
  ['zh', zh.settings.update],
  ['en', en.settings.update],
] as const)('Desktop shell resource rows (%s)', (locale, text) => {
  it('renders each resource and its path when developer mode is enabled', async () => {
    useAppStore.setState({ language: locale, developerMode: true });
    render(<UpdateSettings updateInfo={updateInfo} onUpdateInfoChange={vi.fn()} onShowUpdateModal={vi.fn()} />);

    expect(await screen.findByText(text.desktopShell.title)).toBeTruthy();
    expect(screen.getByText('better-sqlite3 native module (better-sqlite3-native)')).toBeTruthy();
    expect(screen.getByText((content) => content.includes('/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'))).toBeTruthy();
    expect(screen.getByText('Required resource (required-resource)')).toBeTruthy();
    expect(screen.getAllByTitle(text.desktopShell.diagnosticLabels.copyPath)).toHaveLength(2);
  });
});
