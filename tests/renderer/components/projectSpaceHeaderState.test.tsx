// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProjectDetail } from '../../../src/shared/contract/project';
import { ProjectSpaceView } from '../../../src/renderer/components/features/projectSpace/ProjectSpaceView';
import { toast } from '../../../src/renderer/hooks/useToast';
import * as projectClient from '../../../src/renderer/services/projectClient';
import { tagClient } from '../../../src/renderer/services/tagClient';
import { useAppStore } from '../../../src/renderer/stores/appStore';

vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjectsWithActivity: vi.fn(),
  getProjectDetail: vi.fn(),
  getProjectArtifacts: vi.fn(),
  promoteToCloudSpace: vi.fn(),
  createInvite: vi.fn(),
  listMembers: vi.fn(),
  listCloudCards: vi.fn(),
  resyncCloudCards: vi.fn(),
}));
vi.mock('../../../src/renderer/services/tagClient', () => ({
  tagClient: { listByProject: vi.fn() },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/renderer/components/features/projectCollaboration/ProjectCollaborationPanel', () => ({
  ProjectCollaborationPanel: () => null,
}));
vi.mock('../../../src/renderer/components/features/projectSpace/ProjectComposer', () => ({
  ProjectComposer: () => null,
}));
vi.mock('../../../src/renderer/components/features/projectSpace/ProjectConfigRail', () => ({
  ProjectConfigRail: () => null,
}));

const PROJECT_ID = 'proj_header_test';
const CLOUD_ID = 'cloud-1';
const PROMOTED_AT = 2;

function projectDetail(spacePromotedAt: number | null, cloudProjectId: string | null): ProjectDetail {
  return {
    project: {
      id: PROJECT_ID,
      name: '每周报告',
      status: 'active',
      createdAt: 1,
      updatedAt: 2,
      spacePromotedAt,
      cloudProjectId,
    },
    sources: [],
    goals: [],
    roles: [],
    sessionIds: [],
  };
}

async function openHeader(spacePromotedAt: number | null, cloudProjectId: string | null) {
  vi.mocked(projectClient.getProjectDetail).mockResolvedValue(projectDetail(spacePromotedAt, cloudProjectId));
  render(<ProjectSpaceView projectId={PROJECT_ID} onBackToList={vi.fn()} />);
  return screen.findByTestId('project-space-invite-open');
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ language: 'zh' });
  vi.mocked(tagClient.listByProject).mockResolvedValue([]);
  vi.mocked(projectClient.listProjectsWithActivity).mockResolvedValue([]);
  vi.mocked(projectClient.getProjectArtifacts).mockResolvedValue([]);
  vi.mocked(projectClient.promoteToCloudSpace).mockResolvedValue({
    localProjectId: PROJECT_ID,
    cloudProjectId: CLOUD_ID,
    name: '每周报告',
  });
  vi.mocked(projectClient.createInvite).mockResolvedValue({
    code: 'INVITE-CODE-1',
    projectId: PROJECT_ID,
    expiresAt: '2026-07-05T00:00:00Z',
    maxUses: 10,
    usedCount: 0,
    revokedAt: null,
  });
});

afterEach(cleanup);

describe('ProjectSpaceView header', () => {
  it('spacePromotedAt=null, cloudProjectId=null: 升级为协作空间', async () => {
    const button = await openHeader(null, null);
    expect(button.textContent).toBe('升级为协作空间');

    fireEvent.click(button);
    const dialog = within(screen.getByRole('dialog', { name: '升级为协作空间' }));
    fireEvent.click(dialog.getByRole('button', { name: '升级' }));
    await waitFor(() => expect(projectClient.promoteToCloudSpace).toHaveBeenCalledWith(PROJECT_ID));
    expect(projectClient.createInvite).not.toHaveBeenCalled();
  });

  it('spacePromotedAt=number, cloudProjectId=null: 升级到云端', async () => {
    const button = await openHeader(PROMOTED_AT, null);
    expect(button.textContent).toBe('升级到云端');
    expect(button.textContent).not.toContain('升级为协作空间');

    fireEvent.click(button);
    const dialog = within(screen.getByRole('dialog', { name: '升级到云端' }));
    expect(dialog.getByTestId('project-space-invite-promote-modal').textContent)
      .toBe('升级后会把这个协作空间同步到云端，可邀请成员协作。需要登录账号。');

    vi.mocked(projectClient.getProjectDetail).mockResolvedValue(projectDetail(PROMOTED_AT, CLOUD_ID));
    fireEvent.click(dialog.getByRole('button', { name: '升级到云端' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已升级到云端'));
    expect(projectClient.promoteToCloudSpace).toHaveBeenCalledWith(PROJECT_ID);
    await screen.findByTestId('project-space-header-cloud-badge');
    expect(button.textContent).toBe('邀请');
  });

  it.each([
    { timestamp: 'null', spacePromotedAt: null },
    { timestamp: 'number', spacePromotedAt: PROMOTED_AT },
  ])('spacePromotedAt=$timestamp, cloudProjectId=id: 邀请', async ({ spacePromotedAt }) => {
    const button = await openHeader(spacePromotedAt, CLOUD_ID);
    expect(button.textContent).toBe('邀请');

    fireEvent.click(button);
    const code = await screen.findByTestId('project-space-invite-code');
    expect((code as HTMLInputElement).value).toBe('INVITE-CODE-1');
    expect(projectClient.createInvite).toHaveBeenCalledWith(PROJECT_ID, { expiresInHours: 72, maxUses: 10 });
    expect(projectClient.promoteToCloudSpace).not.toHaveBeenCalled();
  });
});
