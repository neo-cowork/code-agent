// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';

const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: () => Promise.resolve(undefined), on: () => () => {} },
}));
vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/renderer/services/rolesClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/rolesClient')>();
  return {
    ...actual,
    listRoles: (...args: unknown[]) => listRoles(...(args as [])),
    listRolePacks: vi.fn().mockResolvedValue([]),
  };
});
vi.mock('../../../src/renderer/utils/inviteExpert', () => ({
  inviteExpert: vi.fn().mockResolvedValue(undefined),
  goToExpertThread: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/renderer/services/teamRecipeClient', () => ({
  listTeamRecipes: vi.fn().mockResolvedValue([]),
  createTeamRecipe: vi.fn(),
  updateTeamRecipe: vi.fn(),
  deleteTeamRecipe: vi.fn(),
}));

import { ExpertPanel } from '../../../src/renderer/components/features/expert/ExpertPanel';
import { AgentCommandAutocomplete } from '../../../src/renderer/components/features/chat/ChatInput/AgentCommandAutocomplete';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const entry = (roleId: string, displayName: string, profession: string): RolePanelEntry => ({
  roleId, description: 'd', source: 'builtin', memoryCount: 0, lastWork: null, icon: 'ClipboardList',
  category: 'product', displayName, profession, tags: [], quickPrompts: [],
});

beforeEach(() => {
  listRoles.mockResolvedValue([
    entry('牧之', '牧之', '资深产品经理'),
    { ...entry('我的助手', '我的助手', '写作顾问'), source: 'user' },
  ]);
});
afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });

describe('built-in expert names follow the UI language', () => {
  it('ExpertPanel card head: en shows pinyin + English profession, custom role untouched', async () => {
    useAppStore.setState({ language: 'en' });
    render(<ExpertPanel />);
    fireEvent.click(screen.getByTestId('expert-tab-mine'));
    const card = await screen.findByTestId('expert-card-牧之');
    expect(within(card).getByText('Muzhi')).toBeTruthy();
    expect(within(card).getByText('Senior Product Manager')).toBeTruthy();
    expect(card.textContent).not.toContain('牧之');
    const custom = await screen.findByTestId('expert-card-我的助手');
    expect(within(custom).getByText('我的助手')).toBeTruthy();
    expect(within(custom).getByText('写作顾问')).toBeTruthy();
  });

  it('ExpertPanel card head: zh unchanged', async () => {
    render(<ExpertPanel />);
    fireEvent.click(screen.getByTestId('expert-tab-mine'));
    const card = await screen.findByTestId('expert-card-牧之');
    expect(within(card).getByText('牧之')).toBeTruthy();
    expect(within(card).getByText('资深产品经理')).toBeTruthy();
  });

  const options = [{ id: '牧之', name: '牧之', description: 'd', token: '牧之', group: 'role' as const, profession: '资深产品经理' }];
  it('@ picker row: en shows pinyin but keeps the original @ token', () => {
    useAppStore.setState({ language: 'en' });
    render(<AgentCommandAutocomplete query="" options={options} selectedIndex={0} onSelect={() => {}} onDraftCleared={() => {}} />);
    expect(screen.getByText('Muzhi')).toBeTruthy();
    expect(screen.getByText('Senior Product Manager')).toBeTruthy();
    expect(screen.getByText('牧之')).toBeTruthy(); // token text stays
  });

  it('@ picker row: zh unchanged', () => {
    render(<AgentCommandAutocomplete query="" options={options} selectedIndex={0} onSelect={() => {}} onDraftCleared={() => {}} />);
    expect(screen.getAllByText('牧之').length).toBeGreaterThan(0);
    expect(screen.getByText('资深产品经理')).toBeTruthy();
  });
});

describe('factory team card lead follows the UI language', () => {
  const lead = async () => {
    useAppStore.setState({ expertPanelTab: 'discover' });
    render(<ExpertPanel />);
    const card = await screen.findByTestId('team-recipe-product-spec');
    return card.textContent ?? '';
  };
  it('en: lead expert Muzhi, no CJK in the lead slot', async () => {
    useAppStore.setState({ language: 'en' });
    const text = await lead();
    expect(text).toContain('lead expert Muzhi');
    expect(text.match(/lead expert ([A-Za-z]+)/)?.[1]).not.toMatch(/\p{Script=Han}/u);
  });
  it('zh: lead 牧之 unchanged', async () => {
    expect(await lead()).toContain('牧之');
  });
});
