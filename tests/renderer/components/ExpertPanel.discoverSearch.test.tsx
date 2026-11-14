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
  useAppStore.setState({ expertPanelTab: 'discover', language: 'zh' });
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


describe('ExpertPanel Discover matches in Mine', () => {
  const userExpert = makeEntry({ roleId: 'weekly-proofreader', displayName: '周报校对师', source: 'user', description: '校对周报', profession: '编辑', tags: ['周报'] });

  it.each([
    ['zh', '「我的」里有 1 位匹配「周报校对师」的专家', '去「我的」查看'],
    ['en', '1 matching expert in Mine for "周报校对师"', 'View in Mine'],
  ] as const)('shows localized user-only match and preserves the search on navigation (%s)', async (language, hint, action) => {
    useAppStore.setState({ language });
    listRoles.mockResolvedValue([makeEntry(), userExpert]);
    render(<ExpertPanel />);
    const input = await screen.findByTestId('expert-search-input');
    expect(screen.queryByTestId('expert-discover-mine-hint')).toBeNull();
    fireEvent.change(input, { target: { value: '  周报校对师  ' } });
    const row = screen.getByTestId('expert-discover-mine-hint');
    expect(row.textContent).toContain(hint);
    expect(screen.getByTestId('expert-discover-mine-hint-go').textContent).toBe(action);
    expect(screen.getByTestId('expert-search-empty')).toBeTruthy();
    expect(row.compareDocumentPosition(screen.getByTestId('expert-search-empty')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('expert-card-weekly-proofreader')).toBeNull();

    fireEvent.click(screen.getByTestId('expert-discover-mine-hint-go'));
    expect(screen.getByTestId('expert-tab-mine').getAttribute('aria-selected')).toBe('true');
    expect((screen.getByTestId('expert-search-input') as HTMLInputElement).value).toBe('  周报校对师  ');
    expect(screen.getByTestId('expert-card-weekly-proofreader')).toBeTruthy();
    expect(screen.queryByTestId('expert-card-牧之')).toBeNull();
    expect(screen.queryByTestId('expert-discover-mine-hint')).toBeNull();
  });

  it.each(['zh', 'en'] as const)('counts only non-builtin matches alongside Discover hits (%s)', async (language) => {
    useAppStore.setState({ language });
    listRoles.mockResolvedValue([
      makeEntry({ description: '周报需求梳理' }), userExpert,
      makeEntry({ roleId: 'project-editor', displayName: '项目编辑', source: 'project', description: '周报审阅' }),
      makeEntry({ roleId: 'unrelated', displayName: '画师', source: 'user', description: '画插画' }),
    ]);
    render(<ExpertPanel />);
    const input = await screen.findByTestId('expert-search-input');
    fireEvent.change(input, { target: { value: '周报' } });
    expect(screen.getByTestId('expert-discover-mine-hint').textContent).toContain(language === 'zh'
      ? '「我的」里有 2 位匹配「周报」的专家'
      : '2 matching experts in Mine for "周报"');
    expect(screen.getByTestId('expert-card-牧之')).toBeTruthy();
    expect(screen.queryByTestId('expert-card-weekly-proofreader')).toBeNull();
    expect(screen.queryByTestId('expert-search-empty')).toBeNull();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.queryByTestId('expert-discover-mine-hint')).toBeNull();
  });

  it('has no hint for builtin-only hits or no Mine matches', async () => {
    listRoles.mockResolvedValue([makeEntry(), userExpert]);
    render(<ExpertPanel />);
    const input = await screen.findByTestId('expert-search-input');
    fireEvent.change(input, { target: { value: '牧之' } });
    expect(screen.getByTestId('expert-card-牧之')).toBeTruthy();
    expect(screen.queryByTestId('expert-discover-mine-hint')).toBeNull();
    fireEvent.change(input, { target: { value: '不存在的专家' } });
    expect(screen.getByTestId('expert-search-empty')).toBeTruthy();
    expect(screen.queryByTestId('expert-discover-mine-hint')).toBeNull();
  });
});
