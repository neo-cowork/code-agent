// ============================================================================
// RoleDetailPage 主动性区：「每日简报」选项的说明按角色真实 cadence 显示钟点
// （建专家时可带 dailyBriefTime，08:30 的角色不能还写着 09:00）。经组件公开入口验证。
// ============================================================================
// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelDetail } from '../../../src/shared/contract/roleAssets';

const invokeDomain = vi.fn();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    on: () => () => {},
  },
}));

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: () => Promise.resolve([]),
}));

import { RoleDetailPage } from '../../../src/renderer/components/features/expert/RoleDetailPage';

function detailWith(cadence: string | undefined): RolePanelDetail {
  return {
    roleId: '研究员',
    definition: '---\nname: 研究员\n---\n你是调研专家',
    definitionPath: '/roles/研究员.md',
    memories: [],
    history: [],
    proactivity: { level: 'daily', ...(cadence ? { cadence } : {}) },
    visual: { displayName: '研究员', profession: '调研专家', icon: 'ClipboardList', category: 'research', tags: [], quickPrompts: [] },
    isBuiltin: false,
    personalization: { userExpectation: '', soul: '', boundaries: { disallowExternalSending: false } },
    equipment: { skills: [], tools: [], model: 'balanced', maxIterations: 20, availableSkills: [], availableTools: [] },
  };
}

async function dailyOptionText(cadence: string | undefined): Promise<string> {
  const detail = detailWith(cadence);
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'detail') return Promise.resolve(detail);
    if (action === 'listBoundCronJobs') return Promise.resolve([]);
    if (action === 'listBindings') return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  render(<RoleDetailPage roleId="研究员" />);
  fireEvent.click(await screen.findByTestId('role-detail-tab-records'));
  const options = await screen.findAllByRole('button', { name: /每日简报/ });
  return options[0].textContent ?? '';
}

describe('RoleDetailPage 每日简报说明的钟点', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('cadence 为 0 30 8 * * * → 显示 08:30，不再写死 09:00', async () => {
    const text = await dailyOptionText('0 30 8 * * *');
    expect(text).toContain('每天 08:30');
    expect(text).not.toContain('09:00');
  });

  it('cadence 为 0 0 9 * * * 或缺省 → 显示 09:00', async () => {
    expect(await dailyOptionText('0 0 9 * * *')).toContain('每天 09:00');
    cleanup();
    expect(await dailyOptionText(undefined)).toContain('每天 09:00');
  });
});
