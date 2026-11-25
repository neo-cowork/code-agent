// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeDomain = vi.hoisted(() => vi.fn());
const pickWorkingDirectory = vi.hoisted(() => vi.fn());
const isWebMode = vi.hoisted(() => vi.fn());

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
  isWebMode,
}));

import { WorkspaceSettings } from '../../../src/renderer/components/features/settings/tabs/WorkspaceSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const GONE = '/host/gone-folder';
const LIVE = '/host/live-folder';

function configureHost(exists: boolean, recentDirs: string[] = []) {
  let currentDir = exists ? LIVE : GONE;
  invokeDomain.mockImplementation(async (domain: string, action: string, payload?: { dir?: string }) => {
    if (domain === IPC_DOMAINS.WORKSPACE) {
      if (action === 'getCurrent') return currentDir;
      if (action === 'listRecent') return recentDirs;
      if (action === 'setCurrent' && payload?.dir) {
        currentDir = payload.dir;
        return currentDir;
      }
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
  isWebMode.mockReturnValue(false);
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

  it.each([
    ['zh', '重新选择文件夹', '网页版没法选这台电脑上的文件夹，请在桌面版里重新选择这个文件夹。'],
    ['en', 'Re-select folder', "A browser tab can't choose a folder on this computer. Re-select it in the desktop app."],
  ] as const)('disables reselect and explains desktop recovery in web mode (%s)', async (language, label, hint) => {
    isWebMode.mockReturnValue(true);
    useAppStore.setState({ language });
    configureHost(false);
    render(<WorkspaceSettings />);

    const notice = within(await screen.findByTestId('workspace-directory-missing'));
    const button = notice.getByRole<HTMLButtonElement>('button', { name: label });
    expect(button.disabled).toBe(true);
    expect(notice.getByText(hint)).toBeTruthy();
    fireEvent.click(button);
    expect(pickWorkingDirectory).not.toHaveBeenCalled();
  });

  it('shows a failure, clears it on retry, and updates the workspace after a successful pick', async () => {
    configureHost(false);
    pickWorkingDirectory.mockRejectedValueOnce(new Error('Picker unavailable'));
    render(<WorkspaceSettings />);

    const notice = within(await screen.findByTestId('workspace-directory-missing'));
    const reselect = notice.getByRole('button', { name: '重新选择文件夹' });
    fireEvent.click(reselect);
    expect(await notice.findByText('无法选择文件夹，请重试。')).toBeTruthy();

    const pendingPick = Promise.withResolvers<string>();
    pickWorkingDirectory.mockReturnValueOnce(pendingPick.promise);
    fireEvent.click(reselect);
    expect(notice.getByRole('status').textContent).toBe('');

    configureHost(true);
    pendingPick.resolve(LIVE);
    await waitFor(() => {
      expect(useAppStore.getState().workingDirectory).toBe(LIVE);
      expect(screen.queryByTestId('workspace-directory-missing')).toBeNull();
    });
    expect(await screen.findAllByText(LIVE)).not.toHaveLength(0);
    expect(screen.queryByText('无法选择文件夹，请重试。')).toBeNull();
    expect(screen.queryByText('没有选择文件夹，工作区保持不变。')).toBeNull();
  });

  it.each([null, ''])('shows neutral feedback for a header pick returning %j while the folder is missing', async (result) => {
    configureHost(false);
    pickWorkingDirectory.mockResolvedValueOnce(result);
    render(<WorkspaceSettings />);

    const notice = within(await screen.findByTestId('workspace-directory-missing'));
    fireEvent.click(screen.getByRole('button', { name: '选择目录' }));
    expect(await notice.findByText('没有选择文件夹，工作区保持不变。')).toBeTruthy();
    expect(useAppStore.getState().workingDirectory).toBeNull();
  });

  it('clears cancellation feedback after switching to another missing workspace', async () => {
    const otherMissing = '/host/other-missing-folder';
    configureHost(false, [otherMissing]);
    pickWorkingDirectory.mockResolvedValueOnce(null);
    render(<WorkspaceSettings />);

    fireEvent.click(await screen.findByRole('button', { name: '重新选择文件夹' }));
    expect(await screen.findByText('没有选择文件夹，工作区保持不变。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '切换' }));
    expect(await screen.findByText('找不到项目文件夹“other-missing-folder”。它可能已被移动或删除。')).toBeTruthy();
    const notice = within(screen.getByTestId('workspace-directory-missing'));
    expect(notice.getByRole('status').textContent).toBe('');
  });

  it('keeps feedback from the newest pick when an older pick finishes later', async () => {
    configureHost(false);
    const pendingPick = Promise.withResolvers<null>();
    pickWorkingDirectory.mockReturnValueOnce(pendingPick.promise).mockRejectedValueOnce(new Error('Picker unavailable'));
    render(<WorkspaceSettings />);

    fireEvent.click(await screen.findByRole('button', { name: '重新选择文件夹' }));
    fireEvent.click(screen.getByRole('button', { name: '选择目录' }));
    expect(await screen.findByText('无法选择文件夹，请重试。')).toBeTruthy();

    await act(async () => { pendingPick.resolve(null); });
    expect(screen.getByText('无法选择文件夹，请重试。')).toBeTruthy();
    expect(screen.queryByText('没有选择文件夹，工作区保持不变。')).toBeNull();
  });
});
