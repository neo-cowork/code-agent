// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const composerState = {
  selectedSkillIds: [] as string[],
  selectedConnectorIds: [] as string[],
  selectedMcpServerIds: [] as string[],
  pendingCommand: null as { id: string; name: string } | null,
  setSelectedSkillIds: vi.fn((ids: string[]) => { composerState.selectedSkillIds = ids; }),
  setSelectedConnectorIds: vi.fn(),
  setSelectedMcpServerIds: vi.fn(),
  setTurnCapabilityScopeMode: vi.fn(),
  setPendingCommand: vi.fn((command: { id: string; name: string } | null) => { composerState.pendingCommand = command; }),
};
const sessionState = {
  createSession: vi.fn(),
};
const skillState = {
  mountSkill: vi.fn(),
  setCurrentSession: vi.fn(),
};
vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: Object.assign(
    (selector: (state: typeof composerState) => unknown) => selector(composerState),
    { getState: () => composerState },
  ),
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({ useAppStore: () => vi.fn() }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
    { getState: () => sessionState },
  ),
}));
vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: Object.assign(
    (selector: (state: typeof skillState) => unknown) => selector(skillState),
    { getState: () => skillState },
  ),
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock('../../../src/renderer/utils/startCreateRoleChat', () => ({ startCreateRoleChat: vi.fn() }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {
      sidebar: { newSessionTitle: '新会话' },
      slashSelect: {
        mountSkillNoSession: '挂载 Skill 失败：无法创建会话',
        mountSkillFailedPrefix: '挂载 Skill 失败：',
      },
    },
  }),
}));

import { useChatInputSlashCommands } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSlashCommands';
import { toast } from '../../../src/renderer/hooks/useToast';
import {
  createCommandCandidate,
  removeTrailingSlashToken,
} from '../../../src/renderer/components/features/chat/ChatInput/slashPickerModel';
import type { SlashCommand } from '../../../src/renderer/components/features/chat/ChatInput/SlashCommandPopover';

// insertInlineChip 的测试替身：编辑器侧「触发词原位变 chip」在这里等价于摘掉尾 token
// （chip 挂载点 / 内联位置的验证在 chatInput.inlineChips.test.tsx）。
function makeParams(
  inputValue: string,
  setValue: (next: string | ((previous: string) => string)) => void,
  insertInlineChip = vi.fn(),
) {
  return {
    value: inputValue,
    currentSessionId: 'session-1',
    skillRecommendations: [],
    mountRecommendedSkill: vi.fn(),
    installRecommendedSkill: vi.fn(),
    capabilityItems: [],
    openAgentCommand: vi.fn(),
    focusComposer: vi.fn(),
    insertInlineChip,
    setValue,
    setShowSlashPopover: vi.fn(),
    setSlashFilter: vi.fn(),
    setPendingPromptCommand: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setActiveAgentId: vi.fn(),
    openSeedComposer: vi.fn(),
  };
}

describe('useChatInputSlashCommands', () => {
  it('selects a skill without inserting its name into the input value', async () => {
    composerState.selectedSkillIds = [];
    let inputValue = '帮我处理 /doc';
    const setValue = vi.fn((next: string | ((previous: string) => string)) => {
      inputValue = typeof next === 'function' ? next(inputValue) : next;
    });
    const insertInlineChip = vi.fn(() => { inputValue = removeTrailingSlashToken(inputValue); });
    const { result } = renderHook(() => useChatInputSlashCommands({
      value: inputValue,
      currentSessionId: 'session-1',
      skillRecommendations: [],
      mountRecommendedSkill: vi.fn(),
      installRecommendedSkill: vi.fn(),
      capabilityItems: [],
      openAgentCommand: vi.fn(),
      focusComposer: vi.fn(),
      insertInlineChip,
      setValue,
      setShowSlashPopover: vi.fn(),
      setSlashFilter: vi.fn(),
      setPendingPromptCommand: vi.fn(),
      setPendingAgentSelection: vi.fn(),
      setActiveAgentId: vi.fn(),
      openSeedComposer: vi.fn(),
    }));

    await act(async () => {
      await result.current.selectSkillForCurrentTurn({
        skillName: 'docx',
        libraryId: 'office',
        mounted: true,
      });
    });

    expect(composerState.selectedSkillIds).toEqual(['docx']);
    expect(inputValue).toBe('帮我处理');
    expect(inputValue).not.toContain('<docx>');
  });

  it('带参特色命令（/goal 等 prefill-leading-command）选中后 chip 化：挂 pendingCommand、清触发文本', () => {
    composerState.pendingCommand = null;
    let inputValue = '/go';
    const setValue = vi.fn((next: string | ((previous: string) => string)) => {
      inputValue = typeof next === 'function' ? next(inputValue) : next;
    });
    const insertInlineChip = vi.fn(() => { inputValue = removeTrailingSlashToken(inputValue); });
    const { result } = renderHook(() => useChatInputSlashCommands(makeParams(inputValue, setValue, insertInlineChip)));

    const goalCommand: SlashCommand = {
      ...createCommandCandidate({ id: 'goal', label: '设定目标', description: '直接输入目标', actionKind: 'prefill-leading-command' }),
      icon: null,
      action: vi.fn(),
    };
    act(() => {
      result.current.handleSlashCommandSelect(goalCommand);
    });

    // chip 挂上、触发词原位替换为内联 chip、不再留「/goal 」纯文本前缀（任务 17）
    expect(composerState.pendingCommand).toEqual({ id: 'goal', name: '设定目标' });
    expect(insertInlineChip).toHaveBeenCalledWith({ key: 'command:goal', kind: 'command', id: 'goal' });
    expect(inputValue).toBe('');
    expect(goalCommand.action).not.toHaveBeenCalled();
  });

  it('立即执行类命令（/new 等 execute）不 chip 化，行为不变', () => {
    composerState.pendingCommand = null;
    let inputValue = '/ne';
    const setValue = vi.fn((next: string | ((previous: string) => string)) => {
      inputValue = typeof next === 'function' ? next(inputValue) : next;
    });
    const { result } = renderHook(() => useChatInputSlashCommands(makeParams(inputValue, setValue)));

    const newCommand: SlashCommand = {
      ...createCommandCandidate({ id: 'new', label: '新建会话', description: '创建会话' }),
      icon: null,
      action: vi.fn(),
    };
    act(() => {
      result.current.handleSlashCommandSelect(newCommand);
    });

    expect(composerState.pendingCommand).toBeNull();
    expect(newCommand.action).toHaveBeenCalledTimes(1);
  });

  // ---- deferMountUntilSend（sessionless 协作空间页）：选中未挂载 skill 不抢先建会话 ----
  it('deferMountUntilSend：未挂载 skill 只记当轮选择（chip + selectedSkillIds），不建会话、不挂载、文本不动', async () => {
    composerState.selectedSkillIds = [];
    sessionState.createSession.mockReset();
    skillState.setCurrentSession.mockReset();
    skillState.mountSkill.mockReset();
    vi.mocked(toast.error).mockClear();
    let inputValue = '这是一段用户打好的长文本，选中技能后一个字都不能丢';
    const setValue = vi.fn((next: string | ((previous: string) => string)) => {
      inputValue = typeof next === 'function' ? next(inputValue) : next;
    });
    const insertInlineChip = vi.fn();
    const { result } = renderHook(() => useChatInputSlashCommands({
      ...makeParams(inputValue, setValue, insertInlineChip),
      currentSessionId: null,
      deferMountUntilSend: true,
    }));

    let selected = false;
    await act(async () => {
      selected = await result.current.selectSkillForCurrentTurn({
        skillName: 'explain',
        libraryId: 'official',
        mounted: false,
      });
    });

    expect(selected).toBe(true);
    // 页面不变的关键：不建会话、不切 skillStore 会话、不挂载
    expect(sessionState.createSession).not.toHaveBeenCalled();
    expect(skillState.setCurrentSession).not.toHaveBeenCalled();
    expect(skillState.mountSkill).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    // 选择保留：chip + selectedSkillIds
    expect(insertInlineChip).toHaveBeenCalledWith({ key: 'skill:explain', kind: 'skill', id: 'explain' });
    expect(composerState.selectedSkillIds).toEqual(['explain']);
    // 文本原样（deferred 路径不触碰 value）
    expect(setValue).not.toHaveBeenCalled();
    expect(inputValue).toBe('这是一段用户打好的长文本，选中技能后一个字都不能丢');
  });

  it('非 sessionless（默认）：未挂载 skill 行为逐字节不变——无会话先建会话，再切 skillStore 会话并挂载', async () => {
    composerState.selectedSkillIds = [];
    sessionState.createSession.mockReset().mockResolvedValue({ id: 'sess-created' });
    skillState.setCurrentSession.mockReset();
    skillState.mountSkill.mockReset().mockResolvedValue(true);
    vi.mocked(toast.error).mockClear();
    let inputValue = '帮我解释这段代码';
    const setValue = vi.fn((next: string | ((previous: string) => string)) => {
      inputValue = typeof next === 'function' ? next(inputValue) : next;
    });
    const insertInlineChip = vi.fn();
    const { result } = renderHook(() => useChatInputSlashCommands({
      ...makeParams(inputValue, setValue, insertInlineChip),
      currentSessionId: null,
    }));

    let selected = false;
    await act(async () => {
      selected = await result.current.selectSkillForCurrentTurn({
        skillName: 'explain',
        libraryId: 'official',
        mounted: false,
      });
    });

    expect(selected).toBe(true);
    expect(sessionState.createSession).toHaveBeenCalledTimes(1);
    expect(sessionState.createSession).toHaveBeenCalledWith('新会话');
    expect(skillState.setCurrentSession).toHaveBeenCalledWith('sess-created');
    expect(skillState.mountSkill).toHaveBeenCalledWith('explain', 'official');
    expect(composerState.selectedSkillIds).toEqual(['explain']);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('非 sessionless：建会话失败报 mountSkillNoSession 且不选中（既有降级不变）', async () => {
    composerState.selectedSkillIds = [];
    sessionState.createSession.mockReset().mockResolvedValue(null);
    vi.mocked(toast.error).mockClear();
    let inputValue = '帮我解释这段代码';
    const setValue = vi.fn((next: string | ((previous: string) => string)) => {
      inputValue = typeof next === 'function' ? next(inputValue) : next;
    });
    const { result } = renderHook(() => useChatInputSlashCommands({
      ...makeParams(inputValue, setValue),
      currentSessionId: null,
    }));

    let selected = true;
    await act(async () => {
      selected = await result.current.selectSkillForCurrentTurn({
        skillName: 'explain',
        libraryId: 'official',
        mounted: false,
      });
    });

    expect(selected).toBe(false);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('挂载 Skill 失败：无法创建会话');
    expect(composerState.selectedSkillIds).toEqual([]);
  });
});
