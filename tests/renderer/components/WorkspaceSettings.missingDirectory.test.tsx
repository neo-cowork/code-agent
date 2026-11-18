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

const GONE = '/host/gone-folder';
const LIVE = '/host/live-folder';

function configureHost(exists: boolean) {
  invokeDomain.mockImplementation(async (domain: string, action: string, payload?: { dir?: string }) => {
    if (domain === IPC_DOMAINS.WORKSPACE) {
      if (action === 'getCurrent') return exists ? LIVE : GONE;
      if (action === 'listRecent') return [];
      if (action === 'getConfigScope') return null;
      if (action === 'getDirectorySummary') {
        return { path: payload?.dir, exists, isDirectory: exists };
      }
    }
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
      return { workspace: { recentDirectories: [] } };
    }
    return null;
  });
}

beforeEach(() => {
  useAppStore.setState({ language: 'zh', workingDirectory: null });
  pickWorkingDirectory.mockResolvedValue(LIVE);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WorkspaceSettings missing current directory', () => {
  it('shows the missing-folder warning and reselect when the directory does not exist', async () => {
    configureHost(false);
    render(<WorkspaceSettings />);
    expect(await screen.findByTestId('workspace-directory-missing')).toBeTruthy();
    expect(screen.getByText('找不到项目文件夹“gone-folder”。它可能已被移动或删除。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新选择文件夹' }));
    await waitFor(() => expect(pickWorkingDirectory).toHaveBeenCalled());
  });

  it('shows neither the warning nor the reselect action when the directory exists', async () => {
    configureHost(true);
    render(<WorkspaceSettings />);
    await screen.findAllByText(LIVE);
    expect(screen.queryByTestId('workspace-directory-missing')).toBeNull();
    expect(screen.queryByRole('button', { name: '重新选择文件夹' })).toBeNull();
    expect(screen.queryByText(/找不到项目文件夹/)).toBeNull();
  });
});
