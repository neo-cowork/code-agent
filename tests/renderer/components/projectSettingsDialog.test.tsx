// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDetail } from '../../../src/shared/contract/project';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const mocks = vi.hoisted(() => ({
  getProjectDetail: vi.fn(),
  getProjectSourceGitStates: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  invokeDomain: vi.fn(),
  isWebMode: vi.fn(),
  isTauriMode: vi.fn(),
  dialogOpen: vi.fn(),
  language: { value: 'en' as 'en' | 'zh' },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.dialogOpen,
}));

vi.mock('../../../src/renderer/services/projectClient', () => ({
  getProjectDetail: mocks.getProjectDetail,
  getProjectSourceGitStates: mocks.getProjectSourceGitStates,
  updateProject: mocks.updateProject,
  deleteProject: mocks.deleteProject,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: mocks.invokeDomain },
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: mocks.language.value === 'zh' ? zh : en, language: mocks.language.value }),
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: mocks.isWebMode,
  isTauriMode: mocks.isTauriMode,
}));

import { ProjectSettingsDialog } from '../../../src/renderer/components/ProjectSettingsDialog';

function detail(): ProjectDetail {
  return {
    project: {
      id: 'project-1',
      name: 'Neo',
      description: 'Multi-source',
      workspacePath: '/repo/main',
      workspaceKey: 'key',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      sourceRevision: 3,
    },
    sources: [{
      id: 'source-primary',
      projectId: 'project-1',
      path: '/repo/main',
      canonicalPath: '/repo/main',
      role: 'primary',
      access: 'read_write',
      trustState: 'trusted',
      identityDev: '1',
      identityIno: '2',
      createdAt: 1,
      updatedAt: 1,
    }],
    goals: [],
    roles: [],
    sessionIds: [],
  };
}

describe('ProjectSettingsDialog', () => {
  beforeEach(() => {
    mocks.language.value = 'en';
    vi.clearAllMocks();
    mocks.isWebMode.mockReturnValue(false);
    mocks.isTauriMode.mockReturnValue(true);
    mocks.dialogOpen.mockResolvedValue('/repo/docs');
    mocks.getProjectDetail.mockResolvedValue(detail());
    mocks.getProjectSourceGitStates.mockResolvedValue([]);
    mocks.updateProject.mockImplementation(async (input) => ({
      ...detail(),
      project: { ...detail().project, sourceRevision: input.revision + 1 },
      sources: input.sources.map((source: Record<string, unknown>, index: number) => ({
        id: source.id ?? `source-${index}`,
        projectId: 'project-1',
        canonicalPath: source.path,
        identityDev: '1',
        identityIno: String(index + 2),
        createdAt: 1,
        updatedAt: 2,
        ...source,
      })),
    }));
    mocks.invokeDomain.mockImplementation(async (_domain, action) => (
      action === 'setCurrent' ? '/repo/docs' : { state: 'trusted' }
    ));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders English copy and adds an Additional Source as read-only by default', async () => {
    render(<ProjectSettingsDialog projectId="project-1" open onClose={() => undefined} />);

    const dialog = await screen.findByRole('dialog', { name: 'Edit project' });
    expect(dialog.parentElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: /Add folder/i }));

    await waitFor(() => expect(screen.getAllByTestId('project-source-row')).toHaveLength(2));
    expect(mocks.dialogOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Add folder',
    });
    expect(mocks.invokeDomain).toHaveBeenCalledWith(expect.anything(), 'setCurrent', { dir: '/repo/docs' });
    const access = screen.getByLabelText('Source access /repo/docs') as HTMLSelectElement;
    expect(access.value).toBe('read_only');

    fireEvent.change(access, { target: { value: 'read_write' } });
    expect(window.confirm).toHaveBeenCalledWith('Allow Agent Neo to write to this Source?\n/repo/docs');
    expect(access.value).toBe('read_write');
  });

  async function failSave(rejection: unknown) {
    mocks.updateProject.mockRejectedValueOnce(rejection);
    const onClose = vi.fn();
    render(<ProjectSettingsDialog projectId="project-1" open onClose={onClose} />);
    await screen.findByRole('dialog', { name: en.sidebarProject.settings.title }).catch(
      () => screen.findByRole('dialog', { name: zh.sidebarProject.settings.title }),
    );
    const name = screen.getByLabelText(mocks.language.value === 'zh' ? zh.sidebarProject.settings.name : 'Project name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Neo changed' } });
    fireEvent.click(screen.getByRole('button', { name: mocks.language.value === 'zh' ? zh.sidebarProject.settings.save : 'Save' }));
    const alert = await screen.findByRole('alert');
    return { alert, name, onClose };
  }

  it.each(['en', 'zh'] as const)('constrains long source paths so row controls stay inside the card (%s)', async (lang) => {
    mocks.language.value = lang;
    const longPath = `/Users/leo/work/${'very-deep-folder-name/'.repeat(6)}project`;
    expect(longPath.length).toBeGreaterThan(120);
    const base = detail();
    mocks.getProjectDetail.mockResolvedValue({
      ...base,
      sources: [
        { ...base.sources[0], path: longPath, canonicalPath: longPath },
        { ...base.sources[0], id: 'source-2', path: `${longPath}-docs`, canonicalPath: `${longPath}-docs`, role: 'additional', access: 'read_only' },
      ],
    });
    render(<ProjectSettingsDialog projectId="project-1" open onClose={() => undefined} />);
    const rows = await screen.findAllByTestId('project-source-row');
    expect(rows).toHaveLength(2);
    const copy = (lang === 'zh' ? zh : en).sidebarProject.settings;
    rows.forEach((row, i) => {
      const fullPath = i === 0 ? longPath : `${longPath}-docs`;
      expect(row.className).toContain('grid-cols-1');
      expect(row.className).toContain('min-w-0');
      const span = row.querySelector(`span[title="${fullPath}"]`) as HTMLElement;
      expect(span.textContent).toBe(fullPath);
      expect(span.className).toContain('truncate');
      expect(span.className).toContain('min-w-0');
      expect(span.parentElement!.className).toContain('min-w-0');
    });
    const remove = screen.getByRole('button', { name: copy.remove });
    expect(remove.className).toContain('shrink-0');
  });

  it.each(['en', 'zh'] as const)('keeps edits open and shows localized plain text when a coded save fails (%s)', async (lang) => {
    mocks.language.value = lang;
    const hostMessage = 'Project Source is missing: /gone/old';
    const { alert, name, onClose } = await failSave(
      Object.assign(new Error(hostMessage), { code: 'PROJECT_UPDATE_PRIMARY_UNWRITABLE' }),
    );
    const copy = (lang === 'zh' ? zh : en).sidebarProject.settings;
    expect(alert.textContent).toContain(copy.saveErrors.PROJECT_UPDATE_PRIMARY_UNWRITABLE);
    expect(alert.textContent).not.toContain(hostMessage);
    expect(alert.textContent).not.toContain('/gone/old');
    expect(name.value).toBe('Neo changed');
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.updateProject).toHaveBeenCalledTimes(1);
  });

  it.each(['en', 'zh'] as const)('unknown save error shows one localized sentence, never the raw message (%s)', async (lang) => {
    mocks.language.value = lang;
    const { alert } = await failSave(new Error('revision conflict: raw English'));
    const copy = (lang === 'zh' ? zh : en).sidebarProject.settings;
    expect(alert.textContent).toContain(copy.saveErrors.fallback);
    expect(alert.textContent).not.toContain('raw English');
  });

  it('every host update error code has zh and en copy, and zh copy has no ASCII internal terms', () => {
    const codes = [
      'PROJECT_UPDATE_RUNNING_TASK', 'PROJECT_UPDATE_DIRTY_SOURCE', 'PROJECT_UPDATE_FOLDER_TRUST',
      'PROJECT_UPDATE_DUPLICATE_PATH', 'PROJECT_UPDATE_UNSAFE_PATH', 'PROJECT_UPDATE_PRIMARY_UNWRITABLE',
      'PROJECT_UPDATE_REVISION_CONFLICT', 'fallback',
    ] as const;
    for (const code of codes) {
      expect(zh.sidebarProject.settings.saveErrors[code]).toMatch(/[\u4e00-\u9fff]/);
      expect(zh.sidebarProject.settings.saveErrors[code]).not.toMatch(/Source|Primary|Folder Trust/);
      expect(en.sidebarProject.settings.saveErrors[code].length).toBeGreaterThan(10);
    }
  });

  it('saves with exactly one updateProject call (no separate Source writes before Save)', async () => {
    mocks.updateProject.mockResolvedValueOnce(detail());
    render(<ProjectSettingsDialog projectId="project-1" open onClose={() => undefined} />);
    await screen.findByRole('dialog', { name: 'Edit project' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalledTimes(1));
    expect(mocks.invokeDomain).not.toHaveBeenCalled();
  });

  it('accepts an explicit Source path in web mode', async () => {
    mocks.isWebMode.mockReturnValue(true);
    render(<ProjectSettingsDialog projectId="project-1" open onClose={() => undefined} />);
    await screen.findByRole('dialog', { name: 'Edit project' });

    fireEvent.change(screen.getByLabelText('Source folder path'), {
      target: { value: '/repo/web-docs' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));

    await waitFor(() => expect(screen.getAllByTestId('project-source-row')).toHaveLength(2));
    expect((screen.getByLabelText('Source access /repo/web-docs') as HTMLSelectElement).value).toBe('read_only');
    expect(mocks.invokeDomain).toHaveBeenCalledWith(expect.anything(), 'set', expect.objectContaining({
      workingDirectory: '/repo/web-docs',
    }));
  });
});
