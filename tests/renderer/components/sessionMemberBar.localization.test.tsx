// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn().mockResolvedValue([]), invokeDomain: vi.fn().mockResolvedValue(null), on: () => () => {} },
}));

import { useSessionMembers } from '../../../src/renderer/components/features/expert/SessionMemberBar';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const entry = (id: string, profession: string) => ({ id, name: id, description: 'd', profession, isRole: true }) as never;

describe('member bar names follow the UI language', () => {
  beforeEach(() => {
    useComposerStore.setState({ selectedTeamRecipeId: 'r1', standbyExcludedMemberKeys: [] });
    useTeamRecipeStore.setState({
      recipes: [{ id: 'r1', name: 'r', description: '', category: 'product', members: [{ roleId: '牧之', taskTemplate: 't' }, { roleId: '旅行规划师', taskTemplate: 't' }] }] as never,
      isLoaded: true,
    });
    useAgentRegistryStore.setState({ entries: [entry('牧之', '资深产品经理'), entry('旅行规划师', '旅行')], isLoaded: true });
    useSessionStore.setState({ sessions: [], currentSessionId: null });
  });
  afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });

  it('en: built-in member shows pinyin + English profession, custom member unchanged', () => {
    useAppStore.setState({ language: 'en' });
    const { result } = renderHook(() => useSessionMembers('s1'));
    expect(result.current.map((m) => [m.roleId, m.name, m.profession])).toEqual([
      ['牧之', 'Muzhi', 'Senior Product Manager'],
      ['旅行规划师', '旅行规划师', '旅行'],
    ]);
  });

  it('zh: unchanged', () => {
    const { result } = renderHook(() => useSessionMembers('s1'));
    expect(result.current.map((m) => [m.roleId, m.name, m.profession])).toEqual([
      ['牧之', '牧之', '资深产品经理'],
      ['旅行规划师', '旅行规划师', '旅行'],
    ]);
  });
});
