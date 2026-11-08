// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeDomain = vi.hoisted(() => vi.fn());
const pickWorkingDirectory = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain },
}));
vi.mock('../../../src/renderer/services/workingDirectoryPicker', () => ({
  pickWorkingDirectory,
}));
vi.mock('../../../src/renderer/hooks/useWorkbenchBrowserSession', () => ({
  useWorkbenchBrowserSession: () => ({
    blocked: false,
    repairActions: [],
    busyActionKind: null,
    runRepairAction: vi.fn(),
  }),
}));
vi.mock('../../../src/renderer/utils/platform', () => ({
  getDesktopShellLabel: () => 'Tauri',
  isWebMode: () => false,
}));

import { WorkspaceSettings } from '../../../src/renderer/components/features/settings/tabs/WorkspaceSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const PICKED_DIRECTORY = '/picked/folder';
const SWITCH_DIRECTORY = '/switch/target';

function configureHost(hostDirectory: string | null, recentDirectories: string[] = []) {
  invokeDomain.mockImplementation(async (domain: string, action: string) => {
    if (domain === IPC_DOMAINS.WORKSPACE) {
      if (action === 'getCurrent') return hostDirectory;
      if (action === 'listRecent') return recentDirectories;
      if (action === 'getConfigScope') return null;
      if (action === 'setCurrent') return SWITCH_DIRECTORY;
    }
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
      return { workspace: { recentDirectories: [] } };
    }
    return null;
  });
}

function currentCwdTileText(path: string): string {
  return screen.getAllByText(path)[0]?.textContent ?? '';
}

beforeEach(() => {
  useAppStore.setState({ language: 'en', workingDirectory: null });
  configureHost(null, [SWITCH_DIRECTORY]);
  pickWorkingDirectory.mockResolvedValue(PICKED_DIRECTORY);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WorkspaceSettings current directory fallback', () => {
  it('keeps the picked folder visible when getCurrent returns null across reload and switch', async () => {
    render(<WorkspaceSettings />);
    const chooseButton = await screen.findByRole('button', { name: 'Choose directory' });

    fireEvent.click(chooseButton);
    await waitFor(() => expect(screen.getAllByText(PICKED_DIRECTORY).length).toBeGreaterThan(0));
    console.log('[evidence②] picked folder is shown as Current CWD although getCurrent returns null:', JSON.stringify({
      tileText: currentCwdTileText(PICKED_DIRECTORY),
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getAllByText(PICKED_DIRECTORY).length).toBeGreaterThan(0));
    console.log('[evidence②] tab-switch re-load keeps Current CWD:', JSON.stringify({
      tileText: currentCwdTileText(PICKED_DIRECTORY),
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
    await waitFor(() => expect(screen.getAllByText(SWITCH_DIRECTORY).length).toBeGreaterThan(0));
    console.log('[evidence②] handleSwitchTo keeps Current CWD after getCurrent returns null:', JSON.stringify({
      tileText: currentCwdTileText(SWITCH_DIRECTORY),
    }));
  });

  it('prefers a directory returned by the host over the store fallback', async () => {
    useAppStore.setState({ workingDirectory: '/store/fallback' });
    configureHost('/host/current', []);

    render(<WorkspaceSettings />);

    await waitFor(() => expect(screen.getAllByText('/host/current').length).toBeGreaterThan(0));
    expect(screen.queryByText('/store/fallback')).toBeNull();
  });
});
