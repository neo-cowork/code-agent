// @vitest-environment jsdom
// 设置页（工作区 / Hooks）：路径行可见文字与 title 都不露 /Users/<账户>；
// 「打开 / 定位」动作仍收到真实绝对路径。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeDomain = vi.hoisted(() => vi.fn());
const ROOT = '/Users/alice/work/foo';
const USER_CFG = '/Users/alice/.code-agent/hooks/hooks.json';
const PROJECT_CFG = `${ROOT}/.code-agent/hooks/hooks.json`;

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain } }));
vi.mock('../../../src/renderer/services/workingDirectoryPicker', () => ({ pickWorkingDirectory: vi.fn() }));
vi.mock('../../../src/renderer/hooks/useWorkbenchBrowserSession', () => ({
  useWorkbenchBrowserSession: () => ({ blocked: false, repairActions: [], busyActionKind: null, runRepairAction: vi.fn() }),
}));
vi.mock('../../../src/renderer/utils/platform', () => ({ getDesktopShellLabel: () => 'Tauri', isWebMode: () => false }));

import { WorkspaceSettings } from '../../../src/renderer/components/features/settings/tabs/WorkspaceSettings';
import { HooksSettings } from '../../../src/renderer/components/features/settings/tabs/HooksSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

function allTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[title]')).map((el) => el.getAttribute('title') ?? '');
}

const scope = {
  workingDirectory: ROOT,
  generatedAt: 1,
  layers: [{
    id: 'user', label: 'User', description: 'user layer', pathLabel: '~', presentCount: 1, activeCount: 1, warningCount: 0,
    items: [{
      id: 'cfg', label: 'Settings', description: 'settings file', path: '/Users/alice/.code-agent/settings.json',
      kind: 'file', exists: true, active: true, private: false, status: 'present',
    }],
  }],
  writeRecommendations: [],
  safetyScan: {
    status: 'clear', scannedAt: 1, workingDirectory: ROOT, totalFindings: 0, criticalCount: 0, warningCount: 0, infoCount: 0,
    targets: [], findings: [],
  },
};

beforeEach(() => {
  invokeDomain.mockImplementation(async (domain: string, action: string) => {
    if (domain === IPC_DOMAINS.WORKSPACE) {
      if (action === 'getCurrent') return ROOT;
      if (action === 'listRecent') return [ROOT, '/Users/alice/work/bar'];
      if (action === 'getConfigScope') return scope;
    }
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return { workspace: { recentDirectories: [] } };
    return null;
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe.each([['en', en], ['zh', zh]] as const)('WorkspaceSettings 路径行 (%s)', (language, copy) => {
  it('最近目录行与配置层表格的可见文字和 title 不含 /Users/，定位动作收到真实路径', async () => {
    useAppStore.setState({ language, workingDirectory: ROOT });
    const { container } = render(<WorkspaceSettings />);
    await screen.findByText('~/work/bar');
    await screen.findByText('~/.code-agent/settings.json');

    const titles = allTitles(container);
    expect(titles).toEqual(expect.arrayContaining(['~/work/bar', '~/.code-agent/settings.json']));
    // 范围外（当前目录卡片 / 详情抽屉）不在本单；这里只断言两处列表行。
    const recentRow = screen.getByText('~/work/bar').closest('tr') as HTMLElement;
    const scopeRow = screen.getByText('~/.code-agent/settings.json').closest('tr') as HTMLElement;
    for (const el of [recentRow, scopeRow]) {
      expect(el.textContent).not.toContain('/Users/');
      expect(allTitles(el)).not.toEqual(expect.arrayContaining([expect.stringContaining('/Users/')]));
    }

    fireEvent.click(Array.from(recentRow.querySelectorAll('button')).find((b) => b.textContent === copy.settings.workspace.actions.open)!);
    fireEvent.click(Array.from(scopeRow.querySelectorAll('button')).find((b) => b.textContent === copy.settings.workspace.actions.locate)!);
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'showItemInFolder', { filePath: '/Users/alice/work/bar' });
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'showItemInFolder', { filePath: '/Users/alice/.code-agent/settings.json' });
    });
  });
});

describe.each([['en', en], ['zh', zh]] as const)('HooksSettings ConfigPathRow (%s)', (language, copy) => {
  it('配置路径行不含 /Users/，打开 / 定位仍收到真实路径', async () => {
    useAppStore.setState({ language });
    const invoke = vi.fn(async (_domain: string, action: string) => (
      action === 'list'
        ? { success: true, data: { enabled: [], unused: [], configPaths: { global: USER_CFG, project: PROJECT_CFG } } }
        : { success: true, data: {} }
    ));
    (window as unknown as { domainAPI: unknown }).domainAPI = { invoke };
    const { container } = render(<HooksSettings />);
    await screen.findByText('~/.code-agent/hooks/hooks.json');

    expect(container.innerHTML).not.toContain('/Users/');
    expect(allTitles(container)).toEqual(expect.arrayContaining(['~/.code-agent/hooks/hooks.json', '~/work/foo/.code-agent/hooks/hooks.json']));

    const actions = copy.settings.hooks.configActions;
    fireEvent.click(screen.getAllByText(actions.open)[0]);
    fireEvent.click(screen.getAllByText(actions.locate)[1]);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_DOMAINS.HOOK, 'openConfigFile', { filePath: USER_CFG });
      expect(invoke).toHaveBeenCalledWith(IPC_DOMAINS.HOOK, 'revealConfigFolder', { filePath: PROJECT_CFG });
    });
  });
});
