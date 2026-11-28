// @vitest-environment jsdom
// ============================================================================
// N-FIX-COMPOSER-POPOVER-CLIPPED-SHORT-VIEWPORT 验收④（a）：
// 矮窗 + 高 composer 时，三个独立 popover 组件（/ 面板、@ 面板、/agent 补全）
// 的 maxHeight 必须等于「anchor 顶 − boundary 顶 − gap」，不再写死 280/240。
// getBoundingClientRect 全部打桩：boundary 记 48（TitleBar 下沿）、anchor 顶按用例给。
// ============================================================================

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

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
  language: 'zh',
}));
const sessionState = vi.hoisted(() => ({
  createSession: vi.fn(),
  clearCurrentSession: vi.fn(),
  archiveSession: vi.fn(),
  addMessage: vi.fn(),
  currentSessionId: 'session-1',
}));
const skillState = vi.hoisted(() => ({
  availableSkills: [],
  mountedSkills: [],
  fetchAvailableSkills: vi.fn(() => Promise.resolve()),
  fetchMountedSkills: vi.fn(() => Promise.resolve()),
  setCurrentSession: vi.fn(),
}));
const composerState = vi.hoisted(() => ({
  selectedSkillIds: [],
  selectedConnectorIds: [],
}));
const modeState = vi.hoisted(() => ({
  setEffortLevel: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof appState) => unknown) =>
      typeof selector === 'function' ? selector(appState) : appState,
    { getState: () => appState },
  ),
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
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
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
  getCommandRegistry: () => ({ list: () => [] }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  invoke: vi.fn(() => Promise.resolve()),
  invokeDomain: vi.fn(() => Promise.resolve()),
  unsafeInvoke: vi.fn(() => new Promise(() => {})),
}));

import { SlashCommandPopover } from '../../../src/renderer/components/features/chat/ChatInput/SlashCommandPopover';
import { AtMentionPopover } from '../../../src/renderer/components/features/chat/ChatInput/AtMentionPopover';
import { AgentCommandAutocomplete } from '../../../src/renderer/components/features/chat/ChatInput/AgentCommandAutocomplete';

// boundary 顶固定 48（TitleBar h-12 下沿）；anchor 顶按用例给。
const BOUNDARY_TOP = 48;
let anchorTop = 0;

function stubLayout() {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.hasAttribute('data-composer-popover-boundary')
      ? BOUNDARY_TOP
      : this.hasAttribute('data-popover-anchor')
        ? anchorTop
        : 0;
    return {
      x: 0, y: top, top, left: 0, right: 800,
      bottom: top + 40, width: 800, height: 40,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

function renderInComposer(children: React.ReactNode, withBoundary = true) {
  return render(
    <div {...(withBoundary ? { 'data-composer-popover-boundary': '' } : {})}>
      <div data-popover-anchor="">{children}</div>
    </div>,
  );
}

function slashProps() {
  return {
    isOpen: true,
    filter: '',
    agents: [],
    skillRecommendations: [],
    capabilityItems: [],
    capabilitySuggestions: [],
    onClose: vi.fn(),
    onSelect: vi.fn(),
  };
}

function atMentionProps() {
  return {
    query: '',
    libraryRows: [],
    fileRows: [],
    sessionRows: [],
    artifactRows: [],
    activeTab: 'all' as const,
    selectedIndex: 0,
    onTabChange: vi.fn(),
    onSelect: vi.fn(),
    onHover: vi.fn(),
  };
}

function agentCommandProps() {
  return {
    query: '',
    options: [
      { id: 'agent-a', name: 'Alpha', description: 'd', token: 'alpha', group: 'agent' as const },
      { id: 'agent-b', name: 'Beta', description: 'd', token: 'beta', group: 'agent' as const },
    ],
    selectedIndex: 0,
    onSelect: vi.fn(),
    onDraftCleared: vi.fn(),
  };
}

describe('composer popover 动态限高（useComposerPopoverMaxHeight）', () => {
  beforeEach(() => {
    anchorTop = 240;
    stubLayout();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('SlashCommandPopover：矮空间时限高 = anchor顶 − boundary顶 − gap，小于旧上限 280', () => {
    renderInComposer(<SlashCommandPopover {...slashProps()} />);
    const popover = document.querySelector('[data-slash-command-popover]') as HTMLElement;
    expect(popover).not.toBeNull();
    // 240 - 48 - 8 = 184 < 280
    expect(popover.style.maxHeight).toBe('184px');
  });

  it('SlashCommandPopover：空间充足时仍受旧上限 280 封顶', () => {
    anchorTop = 500;
    renderInComposer(<SlashCommandPopover {...slashProps()} />);
    const popover = document.querySelector('[data-slash-command-popover]') as HTMLElement;
    expect(popover.style.maxHeight).toBe('280px');
  });

  it('SlashCommandPopover：无 boundary 标记时退回视口顶 0', () => {
    renderInComposer(<SlashCommandPopover {...slashProps()} />, false);
    const popover = document.querySelector('[data-slash-command-popover]') as HTMLElement;
    // 240 - 0 - 8 = 232
    expect(popover.style.maxHeight).toBe('232px');
  });

  it('SlashCommandPopover：窗口 resize 后按新空间重算', () => {
    renderInComposer(<SlashCommandPopover {...slashProps()} />);
    const popover = document.querySelector('[data-slash-command-popover]') as HTMLElement;
    expect(popover.style.maxHeight).toBe('184px');
    anchorTop = 500;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(popover.style.maxHeight).toBe('280px');
  });

  it('AtMentionPopover：限高按同一算法收缩，sticky 搜索行/tab 行留在 popover 内', () => {
    renderInComposer(<AtMentionPopover {...atMentionProps()} />);
    const popover = document.querySelector('[data-at-mention-popover]') as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.style.maxHeight).toBe('184px');
  });

  it('AgentCommandAutocomplete：限高按同一算法收缩，上限仍是 240', () => {
    renderInComposer(<AgentCommandAutocomplete {...agentCommandProps()} />);
    const popover = document.querySelector('[data-agent-command-autocomplete]') as HTMLElement;
    expect(popover).not.toBeNull();
    // 240 - 48 - 8 = 184 < 240
    expect(popover.style.maxHeight).toBe('184px');
    cleanup();
    anchorTop = 500;
    renderInComposer(<AgentCommandAutocomplete {...agentCommandProps()} />);
    const capped = document.querySelector('[data-agent-command-autocomplete]') as HTMLElement;
    expect(capped.style.maxHeight).toBe('240px');
  });
});
