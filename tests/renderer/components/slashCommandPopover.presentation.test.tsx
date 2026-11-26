// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const appState = vi.hoisted(() => ({
  setShowSettings: vi.fn(),
  openSettingsTab: vi.fn(),
  setShowDAGPanel: vi.fn(),
  showDAGPanel: false,
  setShowWorkspace: vi.fn(),
  showWorkspace: false,
  setSidebarCollapsed: vi.fn(),
  sidebarCollapsed: false,
  contextHealth: null,
  modelConfig: { provider: 'test', model: 'test' },
}));
const sessionState = vi.hoisted(() => ({
  createSession: vi.fn(),
  clearCurrentSession: vi.fn(),
  archiveSession: vi.fn(),
  addMessage: vi.fn(),
  currentSessionId: 'session-1',
}));
const skillState = vi.hoisted(() => ({
  availableSkills: [
    { name: 'alpha', description: 'Alpha 技能', promptContent: '', basePath: '/skills/alpha/SKILL.md', allowedTools: [], disableModelInvocation: false, userInvocable: true, executionContext: 'inline', source: 'builtin' },
    { name: 'beta', description: 'Beta 技能', promptContent: '', basePath: '/skills/beta/SKILL.md', allowedTools: [], disableModelInvocation: false, userInvocable: true, executionContext: 'inline', source: 'builtin' },
  ],
  mountedSkills: [],
  fetchAvailableSkills: vi.fn(() => Promise.resolve()),
  fetchMountedSkills: vi.fn(() => Promise.resolve()),
  setCurrentSession: vi.fn(),
}));
const composerState = vi.hoisted(() => ({
  selectedSkillIds: [],
  selectedConnectorIds: [],
}));
const registryDefs = vi.hoisted(() => ({
  defs: [] as Array<{
    id: string;
    name: string;
    description: string;
    handler: (...args: unknown[]) => unknown;
  }>,
}));
const modeState = vi.hoisted(() => ({
  setEffortLevel: vi.fn(),
}));
const locale = vi.hoisted((): { language: 'zh' | 'en' } => ({ language: 'zh' }));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(() => appState, { getState: () => appState }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(() => sessionState, { getState: () => sessionState }),
}));
vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: Object.assign(
    (selector: (state: typeof skillState) => unknown) => selector(skillState),
    { getState: () => skillState },
  ),
}));
vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: Object.assign(
    (selector: (state: typeof composerState) => unknown) => selector(composerState),
    { getState: () => composerState },
  ),
}));
vi.mock('../../../src/renderer/stores/modeStore', () => ({
  useModeStore: (selector: (state: typeof modeState) => unknown) => selector(modeState),
}));
vi.mock('../../../src/renderer/stores/statusStore', () => ({
  useStatusStore: { getState: () => ({ workingDirectory: '/tmp' }) },
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: locale.language === 'zh' ? zh : en, language: locale.language }) };
});
vi.mock('../../../src/renderer/hooks/useKeybindingsSettings', () => ({
  useKeybindingsSettings: () => ({ keybindings: {}, platform: 'mac' }),
}));
vi.mock('@shared/keybindings', () => ({
  formatShortcutForDisplay: vi.fn(),
  getKeybindingAccelerator: vi.fn(() => undefined),
}));
vi.mock('@shared/commands', () => ({
  initializeCommands: vi.fn(),
  getCommandRegistry: () => ({ list: () => registryDefs.defs }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  invoke: vi.fn(() => Promise.resolve()),
  invokeDomain: vi.fn(() => Promise.resolve()),
  unsafeInvoke: vi.fn(() => new Promise(() => {})),
}));

import { SlashCommandPopover, type SlashCommand } from '../../../src/renderer/components/features/chat/ChatInput/SlashCommandPopover';
import { invokeDomain } from '../../../src/renderer/services/ipcService';

beforeEach(() => {
  vi.restoreAllMocks();
  registryDefs.defs = [];
  locale.language = 'zh';
  sessionState.addMessage.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('SlashCommandPopover 候选行呈现', () => {
  it.each([
    { language: 'zh' as const, labels: ['启动协作助手', '启动协作助手', '启动协作助手', '网页抓取', '外部工具', '外部工具', '管理后台任务', '操作'] },
    { language: 'en' as const, labels: ['Start helper', 'Start helper', 'Start helper', 'Web fetch', 'External tool', 'External tool', 'Manage background jobs', 'Action'] },
  ])('renders /permissions in $language without internal tool IDs', async ({ language, labels }) => {
    locale.language = language;
    const toolNames = ['spawn_agent', 'Task', 'AgentSpawn', 'web_fetch', 'MCPUnified', 'mcp__example__invoke', 'Process', 'unknown_tool'];
    const recent = toolNames.map((toolName, index) => ({
      toolName, summary: index ? toolName : '', outcome: 'auto-approve', reason: '已放行', durationMs: 3,
    }));
    const ipc = vi.mocked(invokeDomain);
    ipc.mockResolvedValueOnce({ mode: 'default' }).mockResolvedValueOnce({ rules: [] })
      .mockResolvedValueOnce({ total: recent.length, recent });
    render(
      <SlashCommandPopover
        isOpen
        filter="permissions"
        agents={[]}
        skillRecommendations={[]}
        capabilityItems={[]}
        capabilitySuggestions={[]}
        onClose={vi.fn()}
        onSelect={(command: SlashCommand) => command.action()}
      />,
    );
    const option = document.querySelector('[data-slash-command-id="permissions"]');
    expect(option).not.toBeNull();
    fireEvent.click(option!);
    await waitFor(() => expect(sessionState.addMessage).toHaveBeenCalledTimes(1));
    const text: string = sessionState.addMessage.mock.calls[0][0].content;
    const outcome = language === 'zh' ? '自动放行' : 'Auto-approved';
    const tail = language === 'zh' ? '（已放行，3 毫秒）' : '(system rule, 3 ms)';
    expect(text.split('\n').filter((line) => line.includes(`→ ${outcome}`))).toEqual(
      labels.map((label) => `    ${label} → ${outcome}  ${tail}`),
    );
    expect(text).not.toContain('auto-approve');
    for (const toolName of toolNames) {
      expect(text.toLowerCase()).not.toContain(toolName.toLowerCase());
    }
  });

  it('技能候选用首字母头像，且不再渲染英文 kind 标签', () => {
    render(
      <SlashCommandPopover
        isOpen
        filter="alpha"
        agents={[]}
        skillRecommendations={[]}
        capabilityItems={[]}
        capabilitySuggestions={[]}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    // 先确认确实渲染出了候选行——否则下面的"不出现"断言会因空列表天然通过（假绿）
    const rows = document.querySelectorAll('[data-slash-command-id]');
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // 技能行用首字母头像
    expect(screen.getByTestId('role-initial-avatar-skill:alpha')).toBeTruthy();

    // 精确整词断言：旧 kind 标签 span 的 textContent 恰好是 'Skill'/'Command' 等；
    // 描述里的「已挂载 Skill」不是整词相等，不会误伤。改动前这条必红。
    const kindWords = new Set(['Command', 'Prompt', 'Agent', 'Skill', 'Connector', 'MCP']);
    const offenders = Array.from(document.querySelectorAll('[data-slash-command-id] span'))
      .filter((el) => kindWords.has((el.textContent || '').trim()));
    expect(offenders).toHaveLength(0);
  });

  it('注册表的 skills 命令（技能列表 /skills）不进 GUI 面板候选', () => {
    registryDefs.defs = [
      { id: 'skills', name: '技能列表', description: 'List skills', handler: vi.fn() },
      { id: 'doctor', name: 'Doctor', description: 'Diagnose', handler: vi.fn() },
    ];

    const props = {
      isOpen: true,
      agents: [] as import('../../../src/shared/contract/agentRegistry').AgentListEntry[],
      skillRecommendations: [],
      capabilityItems: [],
      capabilitySuggestions: [],
      onClose: vi.fn(),
      onSelect: vi.fn(),
    };

    // 对照组：doctor 正常出现，证明 registry 候选链路本身是通的
    const { rerender } = render(<SlashCommandPopover {...props} filter="doctor" />);
    expect(document.querySelector('[data-slash-command-id="doctor"]')).not.toBeNull();

    rerender(<SlashCommandPopover {...props} filter="skills" />);
    expect(document.querySelector('[data-slash-command-id="skills"]')).toBeNull();
  });

  it('IME 组合中的 Enter 不触发 onSelect，普通 Enter 正常选择', () => {
    const onSelect = vi.fn();
    render(
      <SlashCommandPopover
        isOpen
        filter="alpha"
        agents={[]}
        skillRecommendations={[]}
        capabilityItems={[]}
        capabilitySuggestions={[]}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );
    expect(document.querySelectorAll('[data-slash-command-id]').length).toBeGreaterThanOrEqual(1);

    // keyCode 229：IME 确认候选词的 Enter，放行
    fireEvent.keyDown(window, { key: 'Enter', keyCode: 229 });
    expect(onSelect).not.toHaveBeenCalled();

    // isComposing：组合未结束的 Enter，放行
    fireEvent.keyDown(window, { key: 'Enter', isComposing: true });
    expect(onSelect).not.toHaveBeenCalled();

    // 对照：普通 Enter 选择当前高亮项
    fireEvent.keyDown(window, { key: 'Enter', keyCode: 13 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
