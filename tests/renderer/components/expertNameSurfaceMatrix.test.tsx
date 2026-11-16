// @vitest-environment jsdom
// Surface matrix: every expert-name surface × every built-in expert.
// English UI: no CJK in the name/profession slots. Chinese UI: exactly the original strings.
import React from 'react';
import { cleanup, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';
import type { TraceNode } from '../../../src/shared/contract/trace';

const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn().mockResolvedValue([]), invokeDomain: vi.fn().mockResolvedValue(undefined), on: () => () => {} },
}));
vi.mock('../../../src/renderer/services/libraryClient', () => ({ listLibraryItems: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/renderer/services/rolesClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/rolesClient')>();
  return { ...actual, listRoles: () => listRoles(), listRolePacks: vi.fn().mockResolvedValue([]) };
});
vi.mock('../../../src/renderer/utils/inviteExpert', () => ({
  inviteExpert: vi.fn().mockResolvedValue(undefined), goToExpertThread: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/renderer/services/teamRecipeClient', () => ({
  listTeamRecipes: vi.fn().mockResolvedValue([]), createTeamRecipe: vi.fn(), updateTeamRecipe: vi.fn(), deleteTeamRecipe: vi.fn(),
}));

import { ExpertPanel } from '../../../src/renderer/components/features/expert/ExpertPanel';
import { MemberInputNote } from '../../../src/renderer/components/features/expert/MemberInputNote';
import { useSessionMembers } from '../../../src/renderer/components/features/expert/SessionMemberBar';
import { AgentChip } from '../../../src/renderer/components/features/chat/ChatInput/AgentChip';
import { AgentCommandAutocomplete } from '../../../src/renderer/components/features/chat/ChatInput/AgentCommandAutocomplete';
import { createAgentCandidates } from '../../../src/renderer/components/features/chat/ChatInput/slashPickerModel';
import { getDisplaySessionTitle } from '../../../src/renderer/utils/sessionPresentation';
import { buildAgentRows } from '../../../src/renderer/utils/agentRows';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

// roleId, zh display name, zh profession (builtinRoles.ts / cloud packs), expected English name
const EXPERTS = [
  ['数据分析师', '知微', '数据分析师', 'Zhiwei'],
  ['牧之', '牧之', '资深产品经理', 'Muzhi'],
  ['溯真', '溯真', '竞品与市场情报分析师', 'Suzhen'],
  ['青禾', '青禾', '内容主理人', 'Qinghe'],
  ['明镜', '明镜', '项目复盘顾问', 'Mingjing'],
  ['持衡', '持衡', '合同审查顾问', 'Chiheng'],
  ['记言', '记言', '会议纪要与行政助理', 'Jiyan'],
  ['万卷', '万卷', '文献综述研究员', 'Wanjuan'],
  ['岚析', '岚析', '增长分析师', 'Lanxi'],
  ['映川', '映川', '视觉设计师', 'Yingchuan'],
] as const;
const HAN = /\p{Script=Han}/u;

const roleEntry = ([roleId, displayName, profession]: readonly string[]): RolePanelEntry => ({
  roleId, description: 'd', source: 'builtin', memoryCount: 0, lastWork: null, icon: 'ClipboardList',
  category: 'product', displayName, profession, tags: [], quickPrompts: [],
});
const registryEntry = ([id, name, profession]: readonly string[]) =>
  ({ id, name, displayName: name, description: 'd', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [], profession, isRole: true }) as never;

beforeEach(() => {
  listRoles.mockResolvedValue(EXPERTS.map(roleEntry));
  useAgentRegistryStore.setState({ entries: EXPERTS.map(registryEntry), isLoaded: true });
  useComposerStore.setState({
    selectedTeamRecipeId: 'r1', standbyExcludedMemberKeys: [],
  });
  useTeamRecipeStore.setState({
    recipes: [{ id: 'r1', name: 'r', description: '', category: 'product', members: EXPERTS.map(([roleId]) => ({ roleId, taskTemplate: 't' })) }] as never,
    isLoaded: true,
  });
  useSessionStore.setState({ sessions: [], currentSessionId: null });
});
afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh', activeAgentId: null }); });

describe.each(['en', 'zh'] as const)('expert name surfaces in %s', (language) => {
  beforeEach(() => { useAppStore.setState({ language }); });
  const expectedName = (zhName: string, en: string) => (language === 'en' ? en : zhName);

  it.each(EXPERTS)('Capability Hub card · %s', async (roleId, zhName, zhProfession, en) => {
    render(<ExpertPanel />);
    screen.getByTestId('expert-tab-mine').click();
    const card = await screen.findByTestId(`expert-card-${roleId}`);
    expect(within(card).getAllByText(expectedName(zhName, en)).length).toBeGreaterThan(0);
    if (language === 'en') {
      const head = card.querySelector('.truncate');
      expect(head?.textContent ?? '').not.toMatch(HAN);
      expect(within(card).queryByText(zhProfession)).toBeNull();
    } else {
      expect(within(card).getByText(zhProfession)).toBeTruthy();
    }
  });

  it.each(EXPERTS)('@ picker row · %s (token raw)', (roleId, zhName, zhProfession, en) => {
    const option = { id: roleId, name: zhName, description: 'd', token: roleId, group: 'role' as const, profession: zhProfession };
    const view = render(<AgentCommandAutocomplete query="" options={[option]} selectedIndex={0} onSelect={() => {}} onDraftCleared={() => {}} />);
    const spans = Array.from(view.container.querySelectorAll('.truncate')).map((node) => node.textContent);
    expect(spans[0]).toBe(expectedName(zhName, en));
    if (language === 'en') expect(`${spans[0]}${spans[1]}`).not.toMatch(HAN);
    else expect(spans[1]).toBe(zhProfession);
    expect(view.container.textContent).toContain(roleId); // token chip is raw in both languages
    cleanup();
  });

  it.each(EXPERTS)('slash candidate · %s (slash text raw)', (roleId, zhName, zhProfession, en) => {
    const [candidate] = createAgentCandidates([registryEntry([roleId, zhName, zhProfession])], undefined, language);
    expect(candidate.label).toBe(expectedName(zhName, en));
    if (language === 'en') expect(`${candidate.label}${candidate.sublabel ?? ''}`).not.toMatch(HAN);
    expect(candidate.slashText).toBe(`/agent ${zhName}`); // the token is the raw display name in both languages
  });

  it.each(EXPERTS)('composer expert chip · %s', (roleId, zhName, zhProfession, en) => {
    useAppStore.setState({ activeAgentId: roleId });
    const view = render(<AgentChip onOpenAgentCommand={() => {}} />);
    expect(view.container.textContent).toContain(expectedName(zhName, en));
    if (language === 'en') expect(view.container.textContent ?? '').not.toMatch(HAN);
    else expect(view.container.textContent).toContain(zhProfession);
  });

  it.each(EXPERTS)('sidebar expert thread title · %s', (roleId, zhName, _p, en) => {
    // expert threads are titled with the roleId (stored); 知微's thread uses the roleId 数据分析师
    const shown = getDisplaySessionTitle(roleId, language);
    expect(shown).toBe(language === 'en' ? en : roleId);
    expect(shown === en ? true : !HAN.test(shown) || language === 'zh').toBe(true);
    expect(zhName.length).toBeGreaterThan(0);
  });

  it(`member bar pills / agent rows (display fields only) · all experts`, () => {
    const { result } = renderHook(() => useSessionMembers('s1'));
    expect(result.current).toHaveLength(EXPERTS.length);
    const rows = buildAgentRows({ members: result.current, nodes: [], tasks: [] });
    result.current.forEach((pill, index) => {
      const [roleId, zhName, zhProfession, en] = EXPERTS[index];
      // raw fields never change
      expect(pill.roleId).toBe(roleId);
      expect(pill.name).toBe(roleId);
      expect(pill.profession).toBe(zhProfession);
      const shown = rows[index].displayName ?? rows[index].name;
      expect(shown).toBe(language === 'en' ? en : roleId);
      const shownProfession = rows[index].displayProfession ?? rows[index].profession ?? '';
      if (language === 'en') expect(`${shown}${shownProfession}`).not.toMatch(HAN);
      else expect(shownProfession).toBe(zhProfession);
      expect(zhName).toBeTruthy();
    });
  });

  it.each(EXPERTS)('main-chat member note · %s (stored name raw)', (roleId, _zhName, _p, en) => {
    const node: TraceNode = {
      id: 'n', messageId: 'm', type: 'assistant_text', content: 'x', timestamp: 1,
      metadata: { memberInput: { memberId: 'k', memberName: roleId, mode: 'supplement' } },
    };
    const view = render(<MemberInputNote node={node} />);
    const text = view.getByTestId('member-input-note').textContent ?? '';
    if (language === 'en') {
      expect(text).toContain(en);
      expect(text.split('：')[0].split(':')[0]).not.toMatch(HAN);
    } else {
      expect(text).toContain(roleId);
    }
  });
});

describe.each(['en', 'zh'] as const)('factory team card lead in %s', (language) => {
  it.each([['product-spec', '牧之', 'Muzhi'], ['deep-research', '溯真', 'Suzhen'], ['content-campaign', '青禾', 'Qinghe']] as const)(
    'team-recipe-%s',
    async (recipeId, zhLead, enLead) => {
      useAppStore.setState({ language, expertPanelTab: 'discover' });
      render(<ExpertPanel />);
      const card = await screen.findByTestId(`team-recipe-${recipeId}`);
      const text = card.textContent ?? '';
      if (language === 'en') {
        expect(text).toContain(`lead expert ${enLead}`);
        expect(text.match(/lead expert ([A-Za-z]+)/)?.[1]).not.toMatch(HAN);
      } else {
        expect(text).toContain(`牵头专家 ${zhLead}`);
      }
    },
  );
});
