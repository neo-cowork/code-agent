// @vitest-environment jsdom
// Leak canary: English UI localizes built-in expert names at render time only.
// Everything that is sent over IPC, written to a store, or inserted as an @/slash token keeps the raw name.
import React, { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';
import type { SwarmAgentState } from '../../../src/shared/contract/swarm';
import type { SwarmRunAgentRecord, SwarmRunDetail, SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';

const invokeMock = vi.fn();
const invokeDomainMock = vi.fn();
const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const goToExpertThread = vi.fn().mockResolvedValue(undefined);
const swarmState: { agents: SwarmAgentState[]; activeSessionId: string | undefined; messages: never[] } = {
  agents: [], activeSessionId: undefined, messages: [],
};

vi.mock('../../../src/renderer/stores/swarmStore', () => ({ useSwarmStore: (selector: (state: typeof swarmState) => unknown) => selector(swarmState) }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
    on: () => () => {},
  },
}));
vi.mock('../../../src/renderer/services/libraryClient', () => ({ listLibraryItems: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/renderer/services/rolesClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/rolesClient')>();
  return { ...actual, listRoles: () => listRoles(), listRolePacks: vi.fn().mockResolvedValue([]) };
});
vi.mock('../../../src/renderer/utils/inviteExpert', () => ({
  inviteExpert: vi.fn().mockResolvedValue(undefined),
  goToExpertThread: (...args: unknown[]) => goToExpertThread(...args),
}));
vi.mock('../../../src/renderer/services/teamRecipeClient', () => ({
  listTeamRecipes: vi.fn().mockResolvedValue([]), createTeamRecipe: vi.fn(), updateTeamRecipe: vi.fn(), deleteTeamRecipe: vi.fn(),
}));

import { MemberConversationView } from '../../../src/renderer/components/features/expert/MemberConversationView';
import { MemberInputNote } from '../../../src/renderer/components/features/expert/MemberInputNote';
import { ExpertPanel } from '../../../src/renderer/components/features/expert/ExpertPanel';
import { AgentCommandAutocomplete } from '../../../src/renderer/components/features/chat/ChatInput/AgentCommandAutocomplete';
import { createAgentCandidates } from '../../../src/renderer/components/features/chat/ChatInput/slashPickerModel';
import { useSidebarRowActions } from '../../../src/renderer/components/features/sidebar/useSidebarRowActions';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { languages } from '../../../src/renderer/i18n';

const PINYIN = /Muzhi|Zhiwei|Suzhen|Qinghe|Mingjing|Chiheng|Jiyan|Wanjuan|Lanxi|Yingchuan|Senior Product Manager/;

const record: SwarmRunAgentRecord = {
  runId: 'run-1', agentId: 'muzhi-1', name: '牧之', role: '牧之', status: 'running',
  startTime: 1, endTime: null, durationMs: 0, tokensIn: 1, tokensOut: 1, toolCalls: 0, costUsd: 0,
  error: null, failureCategory: null, filesChanged: [], dispatchedTask: '起草', finalOutput: '',
};
const ledgerRun: SwarmRunListItem = {
  id: 'run-1', sessionId: 'session-1', status: 'running', coordinator: 'parallel', startedAt: 1, endedAt: null, durationMs: 0,
  totalAgents: 1, completedCount: 0, failedCount: 0, totalCostUsd: 0, totalTokensIn: 1, totalTokensOut: 1, trigger: 'llm-spawn',
};
const ledgerDetail: SwarmRunDetail = {
  run: { ...ledgerRun, totalToolCalls: 0, parallelPeak: 1, errorSummary: null, aggregation: null, tags: [] },
  agents: [record], events: [],
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((channel: unknown) => {
    if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([ledgerRun]);
    if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) return Promise.resolve(ledgerDetail);
    return Promise.resolve(null);
  });
  invokeDomainMock.mockReset();
  invokeDomainMock.mockResolvedValue({ outcome: 'delivered', effect: 'next_step', persisted: true });
  goToExpertThread.mockClear();
  swarmState.activeSessionId = 'session-1';
  swarmState.agents = [{
    id: 'muzhi-1', name: '牧之', role: '牧之', status: 'running', startTime: 1, iterations: 0,
    tokenUsage: { input: 1, output: 1 }, toolCalls: 0, cost: 0, dispatchedTask: '起草', filesChanged: [],
  }];
  useMemberViewStore.setState({ viewingMemberId: 'muzhi-1' });
  useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
  useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
  useBackgroundTaskStore.setState({ tasks: [] });
  useAgentRegistryStore.setState({
    entries: [{ id: '牧之', name: '牧之', description: '', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [], profession: '资深产品经理', isRole: true }] as never,
    isLoaded: true,
  });
  useSessionStore.setState({ currentSessionId: 'session-1', messages: [], sessions: [] });
  listRoles.mockResolvedValue([{
    roleId: '牧之', description: 'd', source: 'builtin', memoryCount: 0, lastWork: null, icon: 'ClipboardList',
    category: 'product', displayName: '牧之', profession: '资深产品经理', tags: [], quickPrompts: [],
  }]);
  useAppStore.setState({ language: 'en' });
});
afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });

describe('leak canary · member follow-up', () => {
  it('en UI shows Muzhi but sends and stores the raw name; the note re-localizes after a language switch', async () => {
    await act(async () => { render(<MemberConversationView sessionId="session-1" />); });
    const input = await screen.findByTestId('member-input') as HTMLTextAreaElement;
    expect(input.placeholder).toContain('Senior Product Manager'); // zh shows the profession here too
    fireEvent.change(input, { target: { value: 'add page numbers' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('member-input-receipt').getAttribute('data-state')).toBe('delivered'));

    const sent = invokeDomainMock.mock.calls.find((call) => call[1] === 'sendMemberInput');
    expect(sent?.[0]).toBe(IPC_DOMAINS.AGENT);
    expect(sent?.[2]).toMatchObject({ memberName: '资深产品经理', memberId: 'muzhi-1' });
    expect(JSON.stringify(invokeDomainMock.mock.calls)).not.toMatch(PINYIN);

    const stored = useSessionStore.getState().messages.find((message) => message.content === 'add page numbers');
    expect(stored?.metadata?.memberInput).toEqual({ memberId: 'muzhi-1', memberName: '资深产品经理', mode: 'supplement' });
    expect(JSON.stringify(useSessionStore.getState().messages)).not.toMatch(PINYIN);

    const node: TraceNode = {
      id: 'n1', messageId: 'm1', type: 'assistant_text', content: 'add page numbers', timestamp: 1,
      metadata: { memberInput: stored?.metadata?.memberInput as never },
    };
    const note = render(<MemberInputNote node={node} />);
    expect(note.getByTestId('member-input-note').textContent).toContain('Senior Product Manager');
    expect(note.getByTestId('member-input-note').textContent).not.toContain('资深产品经理');
    act(() => useAppStore.setState({ language: 'zh' }));
    note.rerender(<MemberInputNote node={node} />);
    expect(note.getByTestId('member-input-note').textContent).toContain('资深产品经理');
    expect(note.getByTestId('member-input-note').textContent).not.toMatch(PINYIN);
  });
});

describe('leak canary · sidebar rename blur', () => {
  const mountActions = (renameSession: (sessionId: string, title: string) => void) => renderHook(() => {
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const actions = useSidebarRowActions({
      showToast: vi.fn(), canOpenSessionReplay: false,
      setReplayDialog: vi.fn(), setVoiceAuditDialog: vi.fn(), setContextMenu: vi.fn(),
      renamingId, renameValue, setRenamingId, setRenameValue,
      renameInputRef: useRef<HTMLInputElement>(null), renameSession, t: languages.en,
    });
    return { ...actions, renameValue, setRenameValue };
  });
  const session = { id: 's-muzhi', title: '牧之' } as never;
  const dblClick = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent;

  it('pre-fills the display title, and submitting it untouched never writes pinyin back', () => {
    useSessionStore.setState({ sessions: [session] });
    const renameSession = vi.fn<(sessionId: string, title: string) => void>();
    const { result } = mountActions(renameSession);
    act(() => result.current.handleDoubleClick(dblClick, session));
    expect(result.current.renameValue).toBe('Muzhi');
    act(() => result.current.handleRenameSubmit());
    expect(renameSession).not.toHaveBeenCalled();
  });

  it('a real edit is still saved verbatim', () => {
    useSessionStore.setState({ sessions: [session] });
    const renameSession = vi.fn<(sessionId: string, title: string) => void>();
    const { result } = mountActions(renameSession);
    act(() => result.current.handleDoubleClick(dblClick, session));
    act(() => result.current.setRenameValue('产品简报'));
    act(() => result.current.handleRenameSubmit());
    expect(renameSession).toHaveBeenCalledWith('s-muzhi', '产品简报');
  });
});

describe('leak canary · @ / slash insert and invite', () => {
  const option = { id: '牧之', name: '牧之', description: 'd', token: '牧之', group: 'role' as const, profession: '资深产品经理' };

  it('slash candidate shows pinyin but inserts the raw /agent token', () => {
    const [candidate] = createAgentCandidates([{ id: '牧之', name: '牧之', description: 'd', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [], profession: '资深产品经理', isRole: true }] as never, undefined, 'en');
    expect(candidate.label).toBe('Muzhi');
    expect(candidate.slashText).toBe('/agent 牧之');
    expect(candidate.slashText).not.toMatch(PINYIN);
  });

  it('@ picker selects the raw option', () => {
    const onSelect = vi.fn();
    render(<AgentCommandAutocomplete query="" options={[option]} selectedIndex={0} onSelect={onSelect} onDraftCleared={() => {}} />);
    expect(screen.getByText('Muzhi')).toBeTruthy();
    fireEvent.click(screen.getByText('Muzhi'));
    expect(onSelect).toHaveBeenCalledWith(0);
    expect(option).toEqual({ id: '牧之', name: '牧之', description: 'd', token: '牧之', group: 'role', profession: '资深产品经理' });
    expect(screen.getByText('牧之').textContent).toBe('牧之'); // the token chip keeps the raw name
  });

  it('Capability Hub invite passes the raw roleId', async () => {
    render(<ExpertPanel />);
    fireEvent.click(screen.getByTestId('expert-tab-mine'));
    const card = await screen.findByTestId('expert-card-牧之');
    expect(card.textContent).toContain('Muzhi');
    fireEvent.click(screen.getByTestId('expert-invite-牧之'));
    await waitFor(() => expect(goToExpertThread).toHaveBeenCalled());
    expect(JSON.stringify(goToExpertThread.mock.calls)).not.toMatch(PINYIN);
    expect(goToExpertThread.mock.calls[0][0]).toBe('牧之');
    expect(goToExpertThread.mock.calls[0][1]).toMatchObject({ title: '牧之' });
  });
});
