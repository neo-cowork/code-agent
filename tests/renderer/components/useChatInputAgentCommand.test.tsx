// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type React from 'react';
import type { AgentListEntry } from '../../../src/shared/contract/agentRegistry';

const neoWorkCardState = vi.hoisted(() => ({
  detailsById: {},
  loadAll: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/renderer/stores/neoWorkCardStore', () => ({
  useNeoWorkCardStore: Object.assign(
    (selector: (state: typeof neoWorkCardState) => unknown) => selector(neoWorkCardState),
    { getState: () => neoWorkCardState },
  ),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});

import { useChatInputAgentCommand } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputAgentCommand';

const agents: AgentListEntry[] = [
  {
    id: 'coder',
    name: 'Coder',
    description: 'Writes and debugs code.',
    // 传统内置 agent 已从用户可选入口隐藏；面板用例统一走自建 agent
    source: 'user',
    modelTier: 'balanced',
    readonly: false,
    tools: [],
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews code quality.',
    source: 'user',
    modelTier: 'balanced',
    readonly: true,
    tools: [],
  },
];

function setup(value: string) {
  const state = {
    value,
    setValue: vi.fn((next: string | ((previous: string) => string)) => {
      state.value = typeof next === 'function' ? next(state.value) : next;
    }),
    setShowSlashPopover: vi.fn(),
    setSlashFilter: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setActiveAgentId: vi.fn(),
  };
  const hook = renderHook(() => useChatInputAgentCommand({
    value: state.value,
    swarmAgents: [],
    agentEntries: agents,
    inputAreaRef: { current: null },
    focusComposer: vi.fn(),
    setValue: state.setValue,
    setShowSlashPopover: state.setShowSlashPopover,
    setSlashFilter: state.setSlashFilter,
    setPendingAgentSelection: state.setPendingAgentSelection,
    setActiveAgentId: state.setActiveAgentId,
  }));
  return { state, hook };
}

function keyEvent(init: { key: string; keyCode?: number; isComposing?: boolean }) {
  return {
    key: init.key,
    shiftKey: false,
    preventDefault: vi.fn(),
    nativeEvent: {
      isComposing: init.isComposing ?? false,
      keyCode: init.keyCode ?? 0,
    },
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
}

describe('useChatInputAgentCommand', () => {
  it('二级面板选中 agent：chip 立即生效 + 清空 /agent 触发文本', () => {
    const { state, hook } = setup('/agent rev');

    act(() => {
      hook.result.current.handleAgentCommandOptionSelect(0);
    });

    expect(state.setActiveAgentId).toHaveBeenCalledWith('reviewer');
    expect(state.setPendingAgentSelection).toHaveBeenCalledWith({
      id: 'reviewer',
      name: 'Reviewer',
      token: 'reviewer',
      via: 'agent_command',
    });
    expect(state.value).toBe('');
  });

  it('面板已无 Default 项：选项全部是具体专家（恢复默认路由 = 删 chip）', () => {
    const { hook } = setup('/agent ');
    const options = hook.result.current.agentCommandOptions;
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((option) => option.id !== null)).toBe(true);
  });

  it('Enter 正常选择面板项（对照组）', () => {
    const { state, hook } = setup('/agent rev');
    const event = keyEvent({ key: 'Enter', keyCode: 13 });

    let handled: boolean | undefined;
    act(() => {
      handled = hook.result.current.handleAutocompleteKeyDown(event);
    });

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(state.setActiveAgentId).toHaveBeenCalledWith('reviewer');
  });

  it('IME 组合中的 Enter（keyCode 229）不触发选择，放行给输入法', () => {
    const { state, hook } = setup('/agent rev');
    const event = keyEvent({ key: 'Enter', keyCode: 229 });

    let handled: boolean | undefined;
    act(() => {
      handled = hook.result.current.handleAutocompleteKeyDown(event);
    });

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(state.setActiveAgentId).not.toHaveBeenCalled();
    expect(state.value).toBe('/agent rev');
  });

  it('IME isComposing 中的 Enter 同样不触发选择', () => {
    const { state, hook } = setup('/agent rev');
    const event = keyEvent({ key: 'Enter', isComposing: true });

    let handled: boolean | undefined;
    act(() => {
      handled = hook.result.current.handleAutocompleteKeyDown(event);
    });

    expect(handled).toBe(false);
    expect(state.setActiveAgentId).not.toHaveBeenCalled();
  });

  it('@ mention 面板：IME 组合中的 Enter 不插入 mention', () => {
    const state = {
      value: '@al',
      setValue: vi.fn((next: string | ((previous: string) => string)) => {
        state.value = typeof next === 'function' ? next(state.value) : next;
      }),
      setShowSlashPopover: vi.fn(),
      setSlashFilter: vi.fn(),
      setPendingAgentSelection: vi.fn(),
      setActiveAgentId: vi.fn(),
    };
    const hook = renderHook(() => useChatInputAgentCommand({
      value: state.value,
      swarmAgents: [{ id: 'agent-alpha', name: 'alpha' }],
      agentEntries: agents,
      inputAreaRef: { current: null },
      focusComposer: vi.fn(),
      setValue: state.setValue,
      setShowSlashPopover: state.setShowSlashPopover,
      setSlashFilter: state.setSlashFilter,
      setPendingAgentSelection: state.setPendingAgentSelection,
      setActiveAgentId: state.setActiveAgentId,
    }));
    expect(hook.result.current.isAgentMentionAutocompleteOpen).toBe(true);

    const imeEvent = keyEvent({ key: 'Enter', keyCode: 229 });
    let handled: boolean | undefined;
    act(() => {
      handled = hook.result.current.handleAutocompleteKeyDown(imeEvent);
    });
    expect(handled).toBe(false);
    expect(imeEvent.preventDefault).not.toHaveBeenCalled();
    expect(state.value).toBe('@al');

    // 对照：普通 Enter 正常插入 @alpha
    const normalEvent = keyEvent({ key: 'Enter', keyCode: 13 });
    act(() => {
      handled = hook.result.current.handleAutocompleteKeyDown(normalEvent);
    });
    expect(handled).toBe(true);
    expect(state.value).toBe('@alpha ');
  });

  it('@ mention 面板：中文前缀命中中文角色，选中插入 @中文名（N-MENTION-CJK-ROLE-FIX）', () => {
    const state = {
      value: '@设计',
      setValue: vi.fn((next: string | ((previous: string) => string)) => {
        state.value = typeof next === 'function' ? next(state.value) : next;
      }),
      setShowSlashPopover: vi.fn(),
      setSlashFilter: vi.fn(),
      setPendingAgentSelection: vi.fn(),
      setActiveAgentId: vi.fn(),
    };
    const hook = renderHook(() => useChatInputAgentCommand({
      value: state.value,
      swarmAgents: [{ id: 'designer', name: '设计师' }],
      agentEntries: agents,
      inputAreaRef: { current: null },
      focusComposer: vi.fn(),
      setValue: state.setValue,
      setShowSlashPopover: state.setShowSlashPopover,
      setSlashFilter: state.setSlashFilter,
      setPendingAgentSelection: state.setPendingAgentSelection,
      setActiveAgentId: state.setActiveAgentId,
    }));

    expect(hook.result.current.isAgentMentionAutocompleteOpen).toBe(true);
    expect(hook.result.current.agentMentionAutocomplete?.matches.map((m) => m.id)).toEqual(['designer']);

    act(() => {
      hook.result.current.handleAgentMentionSelect('designer');
    });
    expect(state.value).toBe('@设计师 ');
  });
});

describe('useChatInputAgentCommand · @专家名', () => {
  const weekly: AgentListEntry = {
    id: 'weekly-reporter',
    name: '周报整理员',
    description: '把零散笔记整理成周报',
    source: 'user',
    modelTier: 'balanced',
    readonly: false,
    tools: [],
    profession: '行政助理',
  };

  function setupExpert(value: string) {
    const state = {
      value,
      setValue: vi.fn((next: string | ((previous: string) => string)) => {
        state.value = typeof next === 'function' ? next(state.value) : next;
      }),
      setPendingAgentSelection: vi.fn(),
      setActiveAgentId: vi.fn(),
    };
    const hook = renderHook(() => useChatInputAgentCommand({
      value: state.value,
      swarmAgents: [],
      agentEntries: [weekly, ...agents],
      inputAreaRef: { current: null },
      focusComposer: vi.fn(),
      setValue: state.setValue,
      setShowSlashPopover: vi.fn(),
      setSlashFilter: vi.fn(),
      setPendingAgentSelection: state.setPendingAgentSelection,
      setActiveAgentId: state.setActiveAgentId,
    }));
    return { state, hook };
  }

  it('汉字全名与前缀都列出该专家，且只列一次', () => {
    for (const text of ['@周报整理员', '@周报']) {
      const { hook } = setupExpert(text);
      const rows = hook.result.current.agentMentionAutocomplete?.matches ?? [];
      expect(rows.filter((r) => r.expertId === 'weekly-reporter')).toHaveLength(1);
      expect(hook.result.current.isAgentMentionAutocompleteOpen).toBe(true);
    }
  });

  it('Enter 选中：chip 生效、@query 清掉，与 /agent 路径得到同一专家 id', () => {
    const { state, hook } = setupExpert('@周报');
    const event = keyEvent({ key: 'Enter', keyCode: 13 });
    act(() => {
      hook.result.current.handleAutocompleteKeyDown(event);
    });
    expect(state.setActiveAgentId).toHaveBeenCalledWith('weekly-reporter');
    expect(state.setPendingAgentSelection).toHaveBeenCalledWith({
      id: 'weekly-reporter',
      name: '周报整理员',
      token: '周报整理员',
      via: 'agent_command',
    });
    expect(state.value).toBe('');

    const viaMenu = setupExpert('/agent 周报');
    act(() => {
      viaMenu.hook.result.current.handleAgentCommandOptionSelect(0);
    });
    expect(viaMenu.state.setActiveAgentId.mock.calls[0]?.[0]).toBe(state.setActiveAgentId.mock.calls[0]?.[0]);
  });

  it('什么都不匹配时面板不开（交给引用搜索）', () => {
    const { hook } = setupExpert('@zzzzqq');
    expect(hook.result.current.isAgentMentionAutocompleteOpen).toBe(false);
  });
});
