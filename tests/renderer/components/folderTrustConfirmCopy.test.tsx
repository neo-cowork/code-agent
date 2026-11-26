// @vitest-environment jsdom
// 信任确认默认视图不外露原始绝对路径/内部配置文件名；详情展开后才可核对（zh/en × 弹窗/新建空间确认步）。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjectsWithActivity: vi.fn().mockResolvedValue([]),
  createSpace: vi.fn(),
  promoteToSpace: vi.fn(),
  renameProject: vi.fn(),
  setProjectDescription: vi.fn(),
  setProjectStatus: vi.fn(),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  pickNativeDirectory: vi.fn(),
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import ipcService from '../../../src/renderer/services/ipcService';
import { FolderTrustDialog } from '../../../src/renderer/components/FolderTrustDialog';
import { ProjectListView } from '../../../src/renderer/components/features/projectSpace/ProjectListView';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const noop = () => {};
const HOOKS = '.code-agent/hooks/hooks.json';
const LOCALES = [
  { language: 'zh' as const, dict: zh },
  { language: 'en' as const, dict: en },
];

function evaluationOf(displayPath: string, canonicalRealpath: string) {
  return {
    state: 'untrusted' as const,
    canonicalRealpath,
    displayPath,
    identityChanged: false,
    dangerousItems: [{ kind: 'project-hooks', displayPath: HOOKS, risk: 'execution', gated: true }],
    blockedItems: [],
  };
}

function renderDialog(evaluation: ReturnType<typeof evaluationOf>) {
  render(<FolderTrustDialog evaluation={evaluation} onTrust={noop} onBlock={noop} onOpenSettings={noop} />);
  return document.body;
}

describe.each(LOCALES)('folder trust confirm copy ($language)', ({ language, dict }) => {
  beforeEach(() => {
    useAppStore.setState({ language });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const SAME = evaluationOf('/tmp/work-abc/trust-folder', '/tmp/work-abc/trust-folder');
  const DIFF = evaluationOf('/tmp/work-abc/link-folder', '/private/real/place/trust-folder');

  it('dialog: collapsed shows one short line, no config path, no absolute prefix', () => {
    const body = renderDialog(SAME);
    const text = body.textContent ?? '';
    expect(text).toContain(dict.folderTrust.items['project-hooks'].replace('{count}', '1'));
    expect(text).toContain('…/work-abc/trust-folder');
    expect(text).not.toContain('/tmp/work-abc');
    expect(text).not.toContain('.code-agent/');
    expect(text).not.toContain(dict.folderTrust.locationDiffers);
    expect(text).not.toContain(dict.folderTrust.realpath);
  });

  it('dialog: equal paths never show the real path twice, even expanded', () => {
    const body = renderDialog(SAME);
    fireEvent.click(screen.getByTestId('folder-trust-details-toggle'));
    const text = body.textContent ?? '';
    expect(text).toContain(HOOKS);
    expect(text.split('/tmp/work-abc/trust-folder').length - 1).toBe(1);
    expect(text).not.toContain(dict.folderTrust.realpath);
  });

  it('dialog: differing real path gets a plain sentence; real path only inside details', () => {
    const body = renderDialog(DIFF);
    expect(body.textContent).toContain(dict.folderTrust.locationDiffers);
    expect(body.textContent).not.toContain('/private/real/place');
    fireEvent.click(screen.getByTestId('folder-trust-details-toggle'));
    const text = body.textContent ?? '';
    expect(text).toContain('/tmp/work-abc/link-folder');
    expect(text).toContain('/private/real/place/trust-folder');
    expect(text).toContain(HOOKS);
    fireEvent.click(screen.getByTestId('folder-trust-details-toggle'));
    expect(body.textContent).not.toContain('/private/real/place');
    expect(body.textContent).not.toContain('.code-agent/');
  });

  it('create-space confirm step: collapsed has no config path or absolute path; expanded does', async () => {
    vi.mocked(ipcService.invokeDomain).mockResolvedValue(SAME as never);
    const ref = React.createRef<{ openCreate: () => void }>();
    render(<ProjectListView ref={ref} onSelect={noop} />);
    React.act(() => ref.current?.openCreate());
    fireEvent.change(await screen.findByTestId('project-space-create-name'), { target: { value: 'demo' } });
    fireEvent.change(screen.getByTestId('project-space-create-workspace'), { target: { value: '/tmp/work-abc/trust-folder' } });
    fireEvent.click(screen.getByText(dict.projectSpace.createSubmit));

    const confirm = await screen.findByTestId('project-space-create-trust-confirm');
    expect(confirm.textContent).toContain(dict.folderTrust.items['project-hooks'].replace('{count}', '1'));
    expect(confirm.textContent).toContain('…/work-abc/trust-folder');
    expect(confirm.textContent).not.toContain('/tmp/work-abc');
    expect(confirm.textContent).not.toContain('.code-agent/');

    fireEvent.click(screen.getByTestId('folder-trust-details-toggle'));
    expect(confirm.textContent).toContain('/tmp/work-abc/trust-folder');
    expect(confirm.textContent).toContain(HOOKS);
  });
});
