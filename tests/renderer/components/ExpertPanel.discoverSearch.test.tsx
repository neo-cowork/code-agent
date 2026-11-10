// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';
import type { RolePackListItem } from '../../../src/renderer/services/rolesClient';
import type { TeamRecipe } from '../../../src/shared/contract/teamRecipe';

const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const listRolePacks = vi.fn<() => Promise<RolePackListItem[]>>();
const listTeamRecipes = vi.fn<() => Promise<TeamRecipe[]>>();
const createTeamRecipe = vi.fn();
const updateTeamRecipe = vi.fn();
const deleteTeamRecipe = vi.fn();
const installRolePack = vi.fn();
const uninstallRolePack = vi.fn();
const retryRolePackMissingSkills = vi.fn();
const invokeDomain = vi.fn();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args), on: () => () => {} },
}));
vi.mock('../../../src/renderer/services/libraryClient', () => ({ listLibraryItems: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/renderer/services/rolesClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/rolesClient')>();
  return {
    ...actual,
    listRoles: (...args: unknown[]) => listRoles(...(args as [])),
    listRolePacks: (...args: unknown[]) => listRolePacks(...(args as [])),
    installRolePack: (...args: unknown[]) => installRolePack(...(args as [])),
    uninstallRolePack: (...args: unknown[]) => uninstallRolePack(...(args as [])),
    retryRolePackMissingSkills: (...args: unknown[]) => retryRolePackMissingSkills(...(args as [])),
  };
});
vi.mock('../../../src/renderer/utils/inviteExpert', () => ({ goToExpertThread: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../src/renderer/services/teamRecipeClient', () => ({
  listTeamRecipes: (...args: unknown[]) => listTeamRecipes(...(args as [])),
  createTeamRecipe: (...args: unknown[]) => createTeamRecipe(...args),
  updateTeamRecipe: (...args: unknown[]) => updateTeamRecipe(...args),
  deleteTeamRecipe: (...args: unknown[]) => deleteTeamRecipe(...args),
}));

import { ExpertPanel } from '../../../src/renderer/components/features/expert/ExpertPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function makeEntry(overrides: Partial<RolePanelEntry> = {}): RolePanelEntry {
  return {
    roleId: '牧之', description: '帮你把模糊想法磨成能评审、能开工的产品需求', source: 'builtin', memoryCount: 0, lastWork: null,
    icon: 'ClipboardList', category: 'product', displayName: '牧之', profession: '资深产品经理', tags: ['需求梳理'], quickPrompts: [], ...overrides,
  };
}
function makeRolePack(overrides: Partial<RolePackListItem> = {}): RolePackListItem {
  return {
    entry: { roleId: '云端产品顾问', displayName: '云端产品顾问', description: '云端下发的产品专家', agentMd: 'Prompt', visual: { icon: 'ClipboardList', category: 'product', displayName: '云端产品顾问', profession: '产品顾问', tags: ['调研'], quickPrompts: [] }, skills: [{ registryName: 'market-research' }], packVersion: '1.2.0', publisher: 'Neo', reviewedAt: '2026-07-23', tags: ['调研'] },
    tools: ['Read'], installed: false, hasUpdate: false, ...overrides,
  };
}
function makeRecipe(overrides: Partial<TeamRecipe> = {}): TeamRecipe {
  return { id: 'user-recipe-1', name: '我的调研配方', description: '两人各自找证据', category: 'research', members: [{ roleId: '牧之', taskTemplate: '研究 {topic}' }], ...overrides };
}

beforeEach(() => {
  useAppStore.setState({ expertPanelTab: 'discover' });
  listRolePacks.mockResolvedValue([]);
  listTeamRecipes.mockResolvedValue([]);
  createTeamRecipe.mockResolvedValue(makeRecipe({ id: 'user-copied' }));
  updateTeamRecipe.mockResolvedValue(makeRecipe());
  deleteTeamRecipe.mockResolvedValue(undefined);
  installRolePack.mockResolvedValue({ success: true, roleId: '云端产品顾问' });
  uninstallRolePack.mockResolvedValue({ success: true, roleId: '云端产品顾问' });
  retryRolePackMissingSkills.mockResolvedValue({ success: true, roleId: '云端产品顾问', installState: 'complete', missingSkills: [] });
  invokeDomain.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ExpertPanel Discover search', () => {
  it('过滤专家团和云货架，全部分区无命中时首屏只显示可清除的搜索空态', async () => {
    const matchingRecipe = makeRecipe({ id: 'contract-team', name: '合同审阅团', description: '围绕合同条款协作核验', tags: ['合同'] });
    const unrelatedRecipe = makeRecipe({ id: 'content-team', name: '内容战役', description: '规划内容传播节奏', tags: ['内容'] });
    const matchingRolePack = makeRolePack();
    matchingRolePack.entry = { ...matchingRolePack.entry, roleId: '合同云专家', displayName: '合同云专家', description: '检查合同条款风险', tags: ['合同'], visual: { ...matchingRolePack.entry.visual, displayName: '合同云专家', profession: '法务顾问', tags: ['合同'] } };
    const unrelatedRolePack = makeRolePack();
    unrelatedRolePack.entry = { ...unrelatedRolePack.entry, roleId: '视觉云专家', displayName: '视觉云专家', description: '提供视觉设计建议', tags: ['视觉'], visual: { ...unrelatedRolePack.entry.visual, displayName: '视觉云专家', profession: '视觉设计师', tags: ['视觉'] } };
    listRoles.mockResolvedValue([makeEntry({ roleId: '持衡', displayName: '持衡', description: '审阅合同条款与隐私风险', profession: '法务合规顾问', tags: ['合同'] }), makeEntry({ roleId: '无关专家', displayName: '无关专家', description: '负责视觉设计', profession: '视觉设计师', tags: ['视觉'] })]);
    listTeamRecipes.mockResolvedValue([matchingRecipe, unrelatedRecipe]);
    listRolePacks.mockResolvedValue([matchingRolePack, unrelatedRolePack]);

    render(<ExpertPanel />);
    fireEvent.click(screen.getByTestId('expert-tab-discover'));
    await waitFor(() => expect(screen.getByTestId('expert-search-input')).toBeTruthy());
    const searchInput = screen.getByTestId('expert-search-input');
    fireEvent.change(searchInput, { target: { value: '合同' } });
    expect(screen.getByTestId('expert-card-持衡')).toBeTruthy();
    expect(screen.queryByTestId('expert-card-无关专家')).toBeNull();
    expect(screen.getByTestId('team-recipe-contract-team')).toBeTruthy();
    expect(screen.queryByTestId('team-recipe-content-team')).toBeNull();
    expect(screen.getByTestId('role-pack-card-合同云专家')).toBeTruthy();
    expect(screen.queryByTestId('role-pack-card-视觉云专家')).toBeNull();

    fireEvent.change(searchInput, { target: { value: '量子炼金术士' } });
    expect(screen.getByTestId('expert-search-empty')).toBeTruthy();
    expect(screen.queryByTestId('team-recipes-section')).toBeNull();
    expect(screen.queryByRole('heading', { name: '更多专家' })).toBeNull();
    expect(screen.queryAllByTestId(/^expert-card-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^team-recipe-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^role-pack-card-/)).toHaveLength(0);

    fireEvent.click(screen.getByTestId('expert-search-clear'));
    expect(screen.queryByTestId('expert-search-empty')).toBeNull();
    expect(screen.getByTestId('team-recipe-product-spec')).toBeTruthy();
    expect(screen.getByTestId('team-recipe-contract-team')).toBeTruthy();
    expect(screen.getByTestId('role-pack-card-合同云专家')).toBeTruthy();
    expect(screen.getByTestId('role-pack-card-视觉云专家')).toBeTruthy();
  });

  it('云货架加载中或超时时无本地命中仍显示搜索空态、状态提示和重试入口', async () => {
    vi.useFakeTimers();
    try {
      listRoles.mockResolvedValue([makeEntry()]);
      listRolePacks.mockReturnValue(new Promise(() => {}));
      render(<ExpertPanel />);
      await act(async () => {});
      fireEvent.click(screen.getByTestId('expert-tab-discover'));
      fireEvent.change(screen.getByTestId('expert-search-input'), { target: { value: '量子炼金术士' } });
      expect(screen.getByTestId('expert-search-empty')).toBeTruthy();
      expect(screen.getByRole('heading', { name: '更多专家' })).toBeTruthy();
      expect(screen.getByText('正在加载更多专家…')).toBeTruthy();

      await act(async () => { vi.advanceTimersByTime(9000); });
      expect(screen.getByTestId('expert-search-empty')).toBeTruthy();
      expect(screen.queryByText('正在加载更多专家…')).toBeNull();
      expect(screen.getByTestId('role-pack-load-timeout')).toBeTruthy();
      expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('云货架失败时无本地命中仍显示搜索空态和重试入口', async () => {
    listRoles.mockResolvedValue([makeEntry()]);
    listRolePacks.mockRejectedValue(new Error('offline'));
    render(<ExpertPanel />);
    fireEvent.click(screen.getByTestId('expert-tab-discover'));
    await waitFor(() => expect(screen.getByTestId('expert-search-input')).toBeTruthy());
    fireEvent.change(screen.getByTestId('expert-search-input'), { target: { value: '量子炼金术士' } });
    await waitFor(() => expect(screen.getByTestId('role-pack-load-error')).toBeTruthy());
    expect(screen.getByTestId('expert-search-empty')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
