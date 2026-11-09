// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

vi.mock('../../../src/renderer/services/projectClient', () => ({
  listCapabilitySelections: vi.fn().mockResolvedValue([]),
  selectCapability: vi.fn(),
  unselectCapability: vi.fn(),
  addProjectRole: vi.fn(),
  removeProjectRole: vi.fn(),
}));
vi.mock('../../../src/renderer/services/rolesClient', () => ({ listRoles: vi.fn().mockResolvedValue([]) }));
const listJobs = vi.fn();
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: { listJobs: (...args: unknown[]) => listJobs(...args), updateJob: vi.fn() },
}));
vi.mock('../../../src/renderer/services/invokeSkillIPC', () => ({
  invokeSkillIPC: vi.fn().mockResolvedValue([]),
  invokeSkillIPCOrThrow: vi.fn(),
  describeSkillIpcError: vi.fn(() => 'skill error'),
  isSkillFolderTrustError: vi.fn(() => false),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/renderer/components/FolderTrustDialog', () => ({ FolderTrustDialog: () => null }));

import { ProjectConfigRail } from '../../../src/renderer/components/features/projectSpace/ProjectConfigRail';

const PROJECT_ID = 'project-cron-timezone';
const project = {
  id: PROJECT_ID,
  name: '时区测试空间',
  workspacePath: '/tmp/cron-timezone',
  workspaceKey: 'cron-timezone',
  status: 'active',
  description: '测试自动化时间口径',
  createdAt: 1,
  updatedAt: 1,
};
const detail = { project, sources: [], goals: [], roles: [], sessionIds: [] };

function cronJob(timezone: string): CronJobDefinition {
  return {
    id: `job-${timezone}`,
    runsOn: 'local',
    name: timezone === 'Asia/Shanghai' ? '每日前瞻' : '晨间分诊',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '0 15 * * 1-5', timezone },
    action: { type: 'agent', agentType: 'general', prompt: '测试自动化' },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: Date.parse('2030-01-01T07:00:00Z'),
  };
}

function renderRail() {
  render(
    <ProjectConfigRail
      projectId={PROJECT_ID}
      project={project as never}
      detail={detail as never}
      onRefreshDetail={() => undefined}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  listJobs.mockResolvedValue([]);
});

describe('ProjectConfigRail cron timezone', () => {
  it('shows the Shanghai job short time with its zone name', async () => {
    const initialTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    listJobs.mockResolvedValue([cronJob('Asia/Shanghai')]);
    try {
      renderRail();
      fireEvent.click(await screen.findByTestId('project-space-card-automation'));
      await waitFor(() => expect(screen.getByTestId('project-space-card-automation-option-job-Asia/Shanghai').textContent)
        .toContain('下次 01/01 15:00（中国标准时间）'));
    } finally {
      if (initialTz === undefined) delete process.env.TZ;
      else process.env.TZ = initialTz;
    }
  });

  it('keeps the local job short time without a suffix', async () => {
    const initialTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    listJobs.mockResolvedValue([cronJob('America/Los_Angeles')]);
    try {
      renderRail();
      fireEvent.click(await screen.findByTestId('project-space-card-automation'));
      const option = await screen.findByTestId('project-space-card-automation-option-job-America/Los_Angeles');
      expect(option.textContent).toContain('下次 12/31 23:00');
      expect(option.textContent).not.toContain('（');
    } finally {
      if (initialTz === undefined) delete process.env.TZ;
      else process.env.TZ = initialTz;
    }
  });
});
