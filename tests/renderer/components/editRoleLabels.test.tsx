// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { SidebarMessageHitList } from '../../../src/renderer/components/features/sidebar/SidebarMessageHitList';
import { ChatSearchBar } from '../../../src/renderer/components/features/chat/ChatSearchBar';
import { ActiveConversationRewindBanner } from '../../../src/renderer/components/features/chat/ActiveConversationRewindBanner';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useRoleLabelsStore } from '../../../src/renderer/stores/roleLabelsStore';
import { listRoles } from '../../../src/renderer/services/rolesClient';
import { formatEditRoleUserPrompt } from '../../../src/renderer/utils/formatEditRoleUserPrompt';
import { languages } from '../../../src/renderer/i18n';

const mocks = vi.hoisted(() => ({ invokeDomain: vi.fn(), invoke: vi.fn() }));
vi.mock('../../../src/renderer/services/ipcService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/renderer/services/ipcService')>(),
  default: { ...mocks, on: () => () => {} },
  ipcService: { ...mocks, on: () => () => {} },
}));
const builtin: RolePanelEntry = {
  roleId: '数据分析师', displayName: '知微', profession: '数据分析师',
  description: '', source: 'builtin', memoryCount: 0, lastWork: null,
};
const raw = '/edit-role 数据分析师';
const expected = '修改专家：知微（数据分析师）';
const projection = () => projectTurns([{ id: 'user', role: 'user', content: raw, timestamp: 1 }], 'session', false);
const userNode = () => projection().turns[0].nodes.find((node) => node.type === 'user')!;
async function load(roles: RolePanelEntry[] = [builtin]) {
  mocks.invokeDomain.mockResolvedValueOnce(roles);
  await act(async () => { await listRoles(); });
}
afterEach(() => {
  cleanup();
  useRoleLabelsStore.getState().setRoles([]);
  useAppStore.setState({ language: 'zh' });
  vi.resetAllMocks();
});

describe('edit expert label lookup', () => {
  it('built-in role with display name + profession renders the option C label', async () => {
    await load();
    const { container } = render(<TraceNodeRenderer node={userNode()} />);
    expect(container.textContent).toContain(expected);
    expect(screen.getByText(expected)).toBeTruthy();
    console.log(`ASSERT TraceNodeRenderer: ${screen.getByText(expected).textContent}`);
  });
  it.each([
    [{ ...builtin, roleId: '自建专家', source: 'user' as const, displayName: undefined }, '修改专家：自建专家'],
    [{ ...builtin, profession: '知微' }, '修改专家：知微'],
    [{ ...builtin, profession: undefined }, '修改专家：知微'],
    [{ ...builtin, displayName: '数据分析师' }, '修改专家：数据分析师'],
  ])('handles missing and duplicate display fields without parentheses: %j', async (role, text) => {
    await load([role]);
    const node = { ...userNode(), content: `/edit-role ${role.roleId}` };
    render(<TraceNodeRenderer node={node} />);
    expect(screen.getByText(text)).toBeTruthy();
    console.log(`ASSERT label fallback: ${screen.getByText(text).textContent}`);
  });
  it('lookup not loaded yet falls back, lookup loaded later swaps label without remount', async () => {
    let resolve!: (roles: RolePanelEntry[]) => void;
    mocks.invokeDomain.mockReturnValueOnce(new Promise<RolePanelEntry[]>((done) => { resolve = done; }));
    const pending = listRoles();
    render(<TraceNodeRenderer node={userNode()} />);
    expect(screen.getByText('修改专家：数据分析师')).toBeTruthy();
    await act(async () => { resolve([builtin]); await pending; });
    expect(screen.getByText(expected)).toBeTruthy();
    // An existing list refresh updates the same mounted bubble too.
    await load([{ ...builtin, displayName: '新知微' }]);
    expect(screen.getByText('修改专家：新知微（数据分析师）')).toBeTruthy();
  });
  it('failed lookup leaves the original ID available and a later retry recovers', async () => {
    mocks.invokeDomain.mockRejectedValueOnce(new Error('offline'));
    await expect(listRoles()).rejects.toThrow('offline');
    render(<TraceNodeRenderer node={userNode()} />);
    expect(screen.getByText('修改专家：数据分析师')).toBeTruthy();
    await load();
    expect(screen.getByText(expected)).toBeTruthy();
  });
  it('English rendered component uses half-width parentheses', async () => {
    useAppStore.setState({ language: 'en' });
    await load();
    render(<TraceNodeRenderer node={userNode()} />);
    expect(screen.getByText('Edit expert: Zhiwei (Data Analyst)')).toBeTruthy();
    console.log(`ASSERT English: ${screen.getByText('Edit expert: Zhiwei (Data Analyst)').textContent}`);
  });
  it('SidebarMessageHitList subscribes to later lookup loads', async () => {
    const hit = { sessionId: 'session', role: 'user' as const, snippet: raw, timestamp: 1, matchCount: 1, relevance: 1, messagePositionLabel: '消息 1' };
    render(<SidebarMessageHitList sessionId="session" hits={[{ ...hit, messageId: 'best' }, { ...hit, messageId: 'extra' }]} onSelectHit={vi.fn()} />);
    expect(screen.getByText('修改专家：数据分析师')).toBeTruthy();
    await load();
    expect(screen.getByText(expected)).toBeTruthy();
    console.log(`ASSERT SidebarMessageHitList: ${screen.getByText(expected).textContent}`);
  });
  it('ActiveConversationRewindBanner subscribes to later lookup loads', async () => {
    mocks.invokeDomain.mockResolvedValue({ openRewindIds: ['rewind'], messages: [{ message: { role: 'user', content: raw } }] });
    render(<ActiveConversationRewindBanner sessionId="session" onRestored={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('修改专家：数据分析师'));
    await load();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(expected));
    console.log(`ASSERT ActiveConversationRewindBanner: ${screen.getByRole('status').textContent}`);
  });
  it('ChatSearchBar cross-session result uses the same label without changing matching text', async () => {
    await load();
    mocks.invoke.mockResolvedValue({ results: [{ sessionId: 'session', sessionTitle: expected, role: 'user', snippet: raw, timestamp: 1 }], totalMatches: 1, sessionsWithMatches: 1, searchTime: 0 });
    const noop = vi.fn();
    render(<ChatSearchBar visible projection={projection()} onClose={noop} onMatchesChange={noop} onActiveMatchChange={noop} />);
    fireEvent.click(screen.getByRole('button', { name: languages.zh.chatSearch.tabCross }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '数据分析师' } });
    await waitFor(() => expect(screen.getAllByText(expected).length).toBeGreaterThan(0));
    expect(mocks.invoke).toHaveBeenCalledWith(expect.any(String), { query: '数据分析师', options: { limit: 30 } });
    console.log(`ASSERT ChatSearchBar: ${screen.getAllByText(expected).map((node) => node.textContent).join(' | ')}`);
  });
  it('pure formatter preserves unrelated commands, multiline input and unknown IDs', async () => {
    await load();
    const labels = useRoleLabelsStore.getState().labels.zh;
    const template = languages.zh.roleEditReceipt.userPrompt;
    expect(formatEditRoleUserPrompt(raw, template, labels)).toBe(expected);
    expect(formatEditRoleUserPrompt('/edit-role 自建专家', template, labels)).toBe('修改专家：自建专家');
    expect(formatEditRoleUserPrompt('/edit-role toString', template)).toBe('修改专家：toString');
    for (const input of ['/edit-role', '/create-role 数据分析师', `${raw}\n继续`, `请解释 ${raw}`]) {
      expect(formatEditRoleUserPrompt(input, template, labels)).toBe(input);
    }
  });
});
