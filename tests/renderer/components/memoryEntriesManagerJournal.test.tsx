// ============================================================================
// MemoryEntriesManager — 来源会话跳转 + 变更历史 + 后台写入标记
// （N-MEM-JOURNAL-SOURCEJUMP ② ③）
// ============================================================================
// ② 有来源会话 → 可点跳转（带 messageId 落点消息）；会话没了 → 禁用 + 原因
// ③ 详情展示最近变更日志行；最近一次是后台 actor 的条目在列表里带标记
// ============================================================================

// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MemoryChangeJournalResult,
  MemoryChangeJournalRow,
  MemoryEntry,
  MemoryEntryListResult,
  MemoryEntryUpdateResult,
} from '../../../src/shared/contract/memory';
import { parseMemoryJournalSnapshot } from '../../../src/renderer/components/features/settings/tabs/memoryJournalSnapshot';

const invokeDomainMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invokeDomain: invokeDomainMock },
}));

const switchSessionMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(vi.fn(), { getState: () => ({ switchSession: switchSessionMock }) }),
}));

const setPendingSearchJumpMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: Object.assign(vi.fn(), { getState: () => ({ setPendingSearchJump: setPendingSearchJumpMock }) }),
}));

const setShowSettingsMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/stores/appStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/stores/appStore')>();
  return {
    ...actual,
    // 组件只走 getState().setShowSettings；hook 形态（useI18n 的 language/setLanguage/
    // cloudUIStrings）给最小真形状，别让 i18n 在渲染期解构 undefined。
    useAppStore: Object.assign(
      vi.fn(() => ({ language: 'zh', setLanguage: vi.fn(), cloudUIStrings: {} })),
      { getState: () => ({ setShowSettings: setShowSettingsMock }) },
    ),
  };
});

import { formatMemoryEntryUpdatedAt, MemoryEntriesManager } from '../../../src/renderer/components/features/settings/tabs/MemoryEntriesManager';

const now = Date.parse('2026-10-31T08:00:00.000Z');

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mem_entry_1',
    schemaVersion: 2,
    status: 'active',
    kind: 'user',
    scope: 'global',
    title: 'User prefers dark mode',
    summary: 'Dark mode preference',
    content: 'The user prefers dark mode.',
    source: { kind: 'light_file', sourceOfTruth: 'light_file', filePath: 'user.md' },
    evidence: [],
    sessionId: null,
    confidence: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function journalResult(rows: MemoryChangeJournalResult['rows']): MemoryChangeJournalResult {
  return { rows };
}

/** route invokeDomain：MEMORY 动作 + SESSION 存在性探测（只读 sessionExists，load 一律 unexpected） */
function mockBackend(options: {
  entries: MemoryEntry[];
  journal?: MemoryChangeJournalResult['rows'];
  sessionExists?: boolean | 'throw';
  /** memoryEntryUpdate 的返回形状：ok 走成功路径；fail 抛错（走恢复失败路径） */
  updateResult?: 'ok' | 'fail';
}): void {
  invokeDomainMock.mockImplementation(async (domain: string, action: string) => {
    if (domain === 'domain:session' && action === 'sessionExists') {
      if (options.sessionExists === 'throw') throw new Error('probe exploded');
      return options.sessionExists === true;
    }
    if (action === 'memoryEntries') {
      return { entries: options.entries, sourceCounts: { light_file: options.entries.length, db_memory: 0 } } satisfies MemoryEntryListResult;
    }
    if (action === 'memoryEntryJournal') return journalResult(options.journal ?? []);
    if (action === 'memoryEntryUpdate') {
      if (options.updateResult === 'fail') throw new Error('Memory entry not found: mem_entry_1');
      return { entry: options.entries[0] } satisfies MemoryEntryUpdateResult;
    }
    throw new Error(`unexpected invoke ${domain}/${action}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

it('shows the replacement hint only on a candidate row that supersedes a memory', async () => {
  const target = entry({ title: '周会在周二' });
  const candidate = entry({ id: 'proposal', title: '周会改到周三', status: 'candidate', supersedes: 'user.md', source: { ...target.source, filePath: 'proposal.md' } });
  const active = entry({ id: 'active', title: '已采纳的周会安排', supersedes: 'user.md', source: { ...target.source, filePath: 'active.md' } });
  const orphan = entry({ id: 'orphan', title: '新安排', status: 'candidate', supersedes: 'missing.md', source: { ...target.source, filePath: 'orphan.md' } });
  mockBackend({ entries: [target, candidate, active, orphan] });
  render(<MemoryEntriesManager />);

  const rows = await screen.findAllByTestId('memory-entry-row');
  const hint = '采纳后将替换你手写的记忆「周会在周二」。';
  expect(screen.getAllByText(hint)).toHaveLength(1);
  const rowFor = (item: MemoryEntry) => within(rows.find((row) => within(row).queryByText(item.title, { exact: true }))!);
  expect(rowFor(candidate).queryByText(hint)).not.toBeNull();
  expect(rowFor(active).queryByText(hint)).toBeNull();
  expect(rowFor(orphan).queryByText('采纳后将替换你手写的记忆「missing.md」。')).not.toBeNull();
});

it('shows the directive one-by-one hint as a line under the title of a directive candidate only, checkbox stays disabled with the same label', async () => {
  const directive = entry({ id: 'dir', title: '先给结论再讲原因', status: 'candidate', kind: 'directive', source: { kind: 'light_file', sourceOfTruth: 'light_file', filePath: 'dir.md' } });
  const plain = entry({ id: 'plain', title: '周报用蓝色封面', status: 'candidate', kind: 'project', scope: 'project', source: { kind: 'light_file', sourceOfTruth: 'light_file', filePath: 'plain.md' } });
  mockBackend({ entries: [directive, plain] });
  render(<MemoryEntriesManager />);

  const rows = await screen.findAllByTestId('memory-entry-row');
  const rowFor = (item: MemoryEntry) => within(rows.find((row) => within(row).queryByText(item.title, { exact: true }))!);
  const hint = '指令类条目要逐条确认，不能一起确认';
  const directiveRow = rowFor(directive);
  expect(directiveRow.getAllByText(hint)).toHaveLength(1);
  const checkbox = directiveRow.getByLabelText(hint) as HTMLInputElement;
  expect(checkbox.disabled).toBe(true);
  expect(rowFor(plain).queryByText(hint)).toBeNull();
});

describe('MemoryEntriesManager — source session jump (②)', () => {
  it('opens the existing source session and lands on the message when a message id exists', async () => {
    mockBackend({
      entries: [entry({
        sessionId: 'sess-live',
        evidence: [{ sessionId: 'sess-live', messageId: 'msg-123456789' }],
      })],
      sessionExists: true,
    });
    render(<MemoryEntriesManager />);

    const openButton = await screen.findByTestId('memory-entry-source-session-open');
    expect((openButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(openButton);

    await waitFor(() => expect(switchSessionMock).toHaveBeenCalledWith('sess-live'));
    expect(setPendingSearchJumpMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-live',
      messageId: 'msg-123456789',
    }));
  });

  it('lands on the message even when the evidence sessionId was redacted by the sensitive guard (r3)', async () => {
    // 真实链路：evidence[].sessionId 落库时被 guardMemoryMetadata 统一 redact，
    // 顶层 sessionId（记录列）不经过 metadata 才保留原值—— messageId 匹配不能依赖 evidence 的 sessionId。
    mockBackend({
      entries: [entry({
        sessionId: 'sess-live',
        evidence: [{ sessionId: '***REDACTED***', messageId: 'msg-1' }],
      })],
      sessionExists: true,
    });
    render(<MemoryEntriesManager />);

    const openButton = await screen.findByTestId('memory-entry-source-session-open');
    expect((openButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(openButton);

    await waitFor(() => expect(switchSessionMock).toHaveBeenCalledWith('sess-live'));
    expect(setPendingSearchJumpMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-live',
      messageId: 'msg-1',
    }));
  });

  it('closes the settings overlay on jump — switchSession does not close it (r5)', async () => {
    // 设置是 overlay：secondaryPages.ts 的 SECONDARY_PAGE_SHOW_EXCLUSIONS 明确不含
    // showSettings，switchSession 的 closeSecondaryPages 关不掉它——跳转后用户仍被
    // 设置页盖住，看不见落点。必须显式走 setShowSettings(false)（inviteExpert /
    // startCreateRoleChat 等设置内跳聊天同款）。
    mockBackend({
      entries: [entry({ sessionId: 'sess-live' })],
      sessionExists: true,
    });
    render(<MemoryEntriesManager />);

    const openButton = await screen.findByTestId('memory-entry-source-session-open');
    expect((openButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(openButton);

    await waitFor(() => expect(switchSessionMock).toHaveBeenCalledWith('sess-live'));
    expect(setShowSettingsMock).toHaveBeenCalledWith(false);
  });

  it('probes existence via the read-only sessionExists action and never calls the side-effectful load (r4)', async () => {
    // session.load 会 restoreSession：切宿主 currentSessionId/toolCache、清会话缓存、写审计。
    // 选中条目只是探测存在性，绝不能付这些副作用（rework r4）。
    mockBackend({
      entries: [entry({ sessionId: 'sess-live' })],
      sessionExists: true,
    });
    render(<MemoryEntriesManager />);

    const openButton = await screen.findByTestId('memory-entry-source-session-open');
    expect((openButton as HTMLButtonElement).disabled).toBe(false);
    const sessionCalls = invokeDomainMock.mock.calls.filter(([domain]) => domain === 'domain:session');
    expect(sessionCalls).toEqual([['domain:session', 'sessionExists', { sessionId: 'sess-live' }]]);
    expect(sessionCalls.some(([, action]) => action === 'load')).toBe(false);
  });

  it('disables the jump with a reason when the source session no longer exists', async () => {
    mockBackend({
      entries: [entry({ sessionId: 'sess-gone' })],
      sessionExists: false,
    });
    render(<MemoryEntriesManager />);

    const openButton = await screen.findByTestId('memory-entry-source-session-open');
    expect((openButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('memory-entry-source-session-reason').textContent).toContain('来源会话已不存在');
    // 禁用态点不动
    fireEvent.click(openButton);
    expect(switchSessionMock).not.toHaveBeenCalled();
  });

  it('shows the probe-failure reason when existence cannot be confirmed', async () => {
    mockBackend({
      entries: [entry({ sessionId: 'sess-unknown' })],
      sessionExists: 'throw',
    });
    render(<MemoryEntriesManager />);

    const openButton = await screen.findByTestId('memory-entry-source-session-open');
    expect((openButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('memory-entry-source-session-reason').textContent).toContain('无法确认来源会话');
  });

  it('renders no source session block when the entry carries no session id', async () => {
    mockBackend({ entries: [entry({ sessionId: null })], sessionExists: true });
    render(<MemoryEntriesManager />);

    await waitFor(() => expect(screen.getByTestId('memory-entry-history')).toBeTruthy());
    expect(screen.queryByTestId('memory-entry-source-session')).toBeNull();
  });
});

describe('MemoryEntriesManager — change history and background marker (③)', () => {
  it('lists the last journal rows with operation and actor labels', async () => {
    mockBackend({
      entries: [entry()],
      journal: [
        { id: 3, timestamp: now, operation: 'update', memoryId: 'mem_1', entryId: 'mem_entry_1', actor: 'dream', beforeContent: null, afterContent: null, sessionId: null },
        { id: 2, timestamp: now, operation: 'create', memoryId: 'mem_1', entryId: 'mem_entry_1', actor: 'user_manual', beforeContent: null, afterContent: null, sessionId: 'sess-live' },
      ],
    });
    render(<MemoryEntriesManager />);

    const rows = await screen.findAllByTestId('memory-entry-history-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('更新');
    expect(rows[0].textContent).toContain('后台整理');
    expect(rows[1].textContent).toContain('创建');
    expect(rows[1].textContent).toContain('手动');
    expect(rows[1].textContent).toContain('sess-live'.slice(0, 12));
  });

  it('marks entries last changed by a background actor in the list', async () => {
    mockBackend({
      entries: [
        entry({ id: 'mem_bg', title: 'Background write', lastChange: { actor: 'eviction', operation: 'evict', timestamp: now } }),
        entry({ id: 'mem_manual', title: 'Manual write', lastChange: { actor: 'user_manual', operation: 'update', timestamp: now } }),
      ],
      journal: [],
    });
    render(<MemoryEntriesManager />);

    const badges = await screen.findAllByTestId('memory-entry-background-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain('后台写入');
  });

  it('shows the empty placeholder when the journal has no rows', async () => {
    mockBackend({ entries: [entry()], journal: [] });
    render(<MemoryEntriesManager />);

    const history = await screen.findByTestId('memory-entry-history');
    await waitFor(() => expect(history.textContent).toContain('暂无变更记录'));
  });
});

// ============================================================================
// 逐行撤回（N-MEM-JOURNAL-SOURCEJUMP-FU2）：后台 actor 的 update/delete/evict
// 行给「撤回」，确认后把 before 快照整段经 memoryEntryUpdate 写回；截断快照/
// 没有快照/恢复失败 → 禁用 + 一行原因。create 行与手动行不给撤回。
// ============================================================================
function journalRow(overrides: Partial<MemoryChangeJournalRow> = {}): MemoryChangeJournalRow {
  return {
    id: 3,
    timestamp: now,
    operation: 'update',
    memoryId: 'mem_1',
    entryId: 'mem_entry_1',
    actor: 'dream',
    beforeContent: JSON.stringify({ summary: 'User prefers dark mode', status: 'active', content: 'The user prefers dark mode.' }),
    afterContent: null,
    sessionId: null,
    ...overrides,
  };
}

describe('parseMemoryJournalSnapshot — before 快照解析', () => {
  it('parses a full snapshot into title/content/status (summary → title)', () => {
    expect(parseMemoryJournalSnapshot(journalRow().beforeContent)).toEqual({
      restorable: true,
      title: 'User prefers dark mode',
      content: 'The user prefers dark mode.',
      status: 'active',
    });
  });

  it('marks truncated and unparseable snapshots as not restorable', () => {
    expect(parseMemoryJournalSnapshot('{"summary":"a","status":"acti…[truncated]')).toEqual({ restorable: false, reason: 'truncated' });
    expect(parseMemoryJournalSnapshot('not json at all')).toEqual({ restorable: false, reason: 'truncated' });
    expect(parseMemoryJournalSnapshot('{"summary":"a","status":"weird","content":"c"}')).toEqual({ restorable: false, reason: 'truncated' });
  });

  it('returns null when there is no before snapshot (create rows)', () => {
    expect(parseMemoryJournalSnapshot(null)).toBeNull();
  });
});

describe('MemoryEntriesManager — per-row undo (FU2)', () => {
  it('shows Undo only on background update/delete/evict rows, not on create or manual rows', async () => {
    mockBackend({
      entries: [entry()],
      journal: [
        journalRow({ id: 5, actor: 'dream', operation: 'update' }),
        journalRow({ id: 4, actor: 'eviction', operation: 'evict', beforeContent: JSON.stringify({ summary: 's', status: 'active', content: 'c' }) }),
        journalRow({ id: 3, actor: 'import', operation: 'create', beforeContent: null }),
        journalRow({ id: 2, actor: 'user_manual', operation: 'update', beforeContent: JSON.stringify({ summary: 's', status: 'active', content: 'c' }) }),
      ],
    });
    render(<MemoryEntriesManager />);

    const rows = await screen.findAllByTestId('memory-entry-history-row');
    expect(rows).toHaveLength(4);
    const undoButtons = screen.getAllByTestId('memory-entry-history-undo');
    expect(undoButtons).toHaveLength(2);
    expect((undoButtons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((undoButtons[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables the Undo with a reason when the snapshot was truncated', async () => {
    mockBackend({
      entries: [entry()],
      journal: [journalRow({
        beforeContent: '{"summary":"User prefers dark mode","status":"active","content":"The user pre…[truncated]',
      })],
    });
    render(<MemoryEntriesManager />);

    const undoButton = await screen.findByTestId('memory-entry-history-undo');
    expect((undoButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('memory-entry-history-undo-reason').textContent).toContain('改写前快照被截断');
    fireEvent.click(undoButton);
    // 禁用态点不开确认弹窗
    expect(screen.queryByTestId('memory-entry-undo-preview')).toBeNull();
  });

  it('disables the Undo with a reason when an update row has no before snapshot', async () => {
    mockBackend({ entries: [entry()], journal: [journalRow({ beforeContent: null })] });
    render(<MemoryEntriesManager />);

    const undoButton = await screen.findByTestId('memory-entry-history-undo');
    expect((undoButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('memory-entry-history-undo-reason').textContent).toContain('没有改写前快照');
  });

  it('confirms with a preview and sends the snapshot through memoryEntryUpdate', async () => {
    mockBackend({ entries: [entry()], journal: [journalRow()] });
    render(<MemoryEntriesManager />);

    fireEvent.click(await screen.findByTestId('memory-entry-history-undo'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('撤回这次改写？')).toBeTruthy();
    expect(within(dialog).getByTestId('memory-entry-undo-preview').textContent).toBe('The user prefers dark mode.');
    fireEvent.click(within(dialog).getByRole('button', { name: '撤回' }));

    await waitFor(() => {
      const updateCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'memoryEntryUpdate');
      expect(updateCall?.[2]).toEqual({
        action: 'memoryEntryUpdate',
        entryId: 'mem_entry_1',
        title: 'User prefers dark mode',
        content: 'The user prefers dark mode.',
        status: 'active',
        deprecatedBy: null,
      });
    });
    // 成功后：重拉条目 + 重拉历史（journal 至少两次）
    await waitFor(() => {
      const journalCalls = invokeDomainMock.mock.calls.filter(([, action]) => action === 'memoryEntryJournal');
      expect(journalCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('previews only the first 200 chars of long content in the confirm dialog', async () => {
    const longContent = 'x'.repeat(300);
    mockBackend({
      entries: [entry()],
      journal: [journalRow({ beforeContent: JSON.stringify({ summary: 's', status: 'active', content: longContent }) })],
    });
    render(<MemoryEntriesManager />);

    fireEvent.click(await screen.findByTestId('memory-entry-history-undo'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('memory-entry-undo-preview').textContent).toBe(`${'x'.repeat(200)}…`);
  });

  it('does not restore to archived with deprecatedBy cleared and keeps non-active status payloads intact', async () => {
    mockBackend({
      entries: [entry()],
      journal: [journalRow({ operation: 'delete', actor: 'eviction', beforeContent: JSON.stringify({ summary: 'before title', status: 'archived', content: 'before content' }) })],
    });
    render(<MemoryEntriesManager />);

    fireEvent.click(await screen.findByTestId('memory-entry-history-undo'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '撤回' }));

    await waitFor(() => {
      const updateCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'memoryEntryUpdate');
      expect(updateCall?.[2]).toEqual({
        action: 'memoryEntryUpdate',
        entryId: 'mem_entry_1',
        title: 'before title',
        content: 'before content',
        status: 'archived',
      });
    });
  });

  it('disables the row with a reason after a failed restore attempt', async () => {
    mockBackend({ entries: [entry()], journal: [journalRow()], updateResult: 'fail' });
    render(<MemoryEntriesManager />);

    fireEvent.click(await screen.findByTestId('memory-entry-history-undo'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '撤回' }));

    const reason = await screen.findByTestId('memory-entry-history-undo-reason');
    expect(reason.textContent).toContain('该条目当前无法定位');
    const undoButton = screen.getByTestId('memory-entry-history-undo');
    expect((undoButton as HTMLButtonElement).disabled).toBe(true);
  });
});

// ============================================================================
// rework r1：①同页导入/删文件后 entriesRefreshKey 重拉列表；②同条目后台刷新
// 不清未保存草稿（脏标记），撤回是显式覆盖、放行同步。
// ============================================================================
describe('MemoryEntriesManager — same-page refresh and dirty draft (rework r1)', () => {
  /** 动态后端：entries 随闭包变量变化，模拟后台改写/撤回后的服务器状态 */
  function mockDynamicBackend(options: {
    entries: () => MemoryEntry[];
    journal?: MemoryChangeJournalResult['rows'];
  }): void {
    invokeDomainMock.mockImplementation(async (domain: string, action: string) => {
      if (action === 'memoryEntries') {
        const entries = options.entries();
        return { entries, sourceCounts: { light_file: entries.length, db_memory: 0 } } satisfies MemoryEntryListResult;
      }
      if (action === 'memoryEntryJournal') return journalResult(options.journal ?? []);
      if (action === 'memoryEntryUpdate') return { entry: options.entries()[0] } satisfies MemoryEntryUpdateResult;
      throw new Error(`unexpected invoke ${domain}/${action}`);
    });
  }

  const entryListCalls = () => invokeDomainMock.mock.calls.filter(([, action]) => action === 'memoryEntries').length;

  it('reloads the entry list when entriesRefreshKey changes (r1 ①)', async () => {
    mockBackend({ entries: [entry()] });
    const view = render(<MemoryEntriesManager />);
    await screen.findAllByTestId('memory-entry-row');
    const callsBefore = entryListCalls();
    expect(callsBefore).toBeGreaterThanOrEqual(1);

    view.rerender(<MemoryEntriesManager entriesRefreshKey={1} />);
    await waitFor(() => expect(entryListCalls()).toBeGreaterThan(callsBefore));
  });

  it('keeps unsaved edits when the same entry is refreshed by a background rewrite (r1 ②)', async () => {
    let backendEntries = [entry({ content: 'server v1', updatedAt: now })];
    mockDynamicBackend({ entries: () => backendEntries });
    render(<MemoryEntriesManager />);

    const contentBox = await screen.findByLabelText('正文');
    await waitFor(() => expect((contentBox as HTMLTextAreaElement).value).toBe('server v1'));
    fireEvent.change(contentBox, { target: { value: 'user edit' } });
    expect((contentBox as HTMLTextAreaElement).value).toBe('user edit');

    // 后台 actor 改写同一条 → 面板任一动作触发 loadEntries（这里点刷新）
    backendEntries = [entry({ title: 'Server v2 title', content: 'server v2 by background actor', updatedAt: now + 5_000 })];
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(entryListCalls()).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByTestId('memory-entry-row').textContent).toContain('Server v2 title'));

    // 未保存的用户编辑不能被静默清掉
    expect((contentBox as HTMLTextAreaElement).value).toBe('user edit');
  });

  it('replaces a dirty draft with the restored content after undo (explicit overwrite, r1 ②)', async () => {
    const restored = 'original content before rewrite';
    let backendEntries = [entry({ content: 'rewritten by dream', updatedAt: now })];
    mockDynamicBackend({
      entries: () => backendEntries,
      journal: [journalRow({
        actor: 'dream',
        beforeContent: JSON.stringify({ summary: 'User prefers dark mode', status: 'active', content: restored }),
      })],
    });
    render(<MemoryEntriesManager />);

    const contentBox = await screen.findByLabelText('正文');
    await waitFor(() => expect((contentBox as HTMLTextAreaElement).value).toBe('rewritten by dream'));
    fireEvent.change(contentBox, { target: { value: 'my wip edit' } });

    fireEvent.click(await screen.findByTestId('memory-entry-history-undo'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '撤回' }));

    // 撤回确认弹窗已警告覆盖：编辑器必须切到恢复后内容，脏草稿不给保留
    backendEntries = [entry({ content: restored, updatedAt: now + 9_000 })];
    await waitFor(() => expect((contentBox as HTMLTextAreaElement).value).toBe(restored));
  });
});

describe('MemoryEntriesManager — responsive 5-column table layout (N-FIX-MEMORY-ENTRIES-TABLE-960-UPDATED-HEADER-CLIPPED)', () => {
  it('uses table-fixed without min-w-* and merges updated time with source in a 5-column table', async () => {
    const manualEntry = entry({
      id: 'mem_manual_1',
      title: 'Manual weekly report rule',
      source: { kind: 'manual', sourceOfTruth: 'light_file', filePath: 'manual.md' },
      updatedAt: now,
    });
    const normalEntry = entry({
      id: 'mem_normal_1',
      title: 'Normal light file memory',
      status: 'candidate',
      kind: 'feedback',
      source: { kind: 'light_file', sourceOfTruth: 'light_file', filePath: 'normal.md' },
      updatedAt: now - 3_600_000,
    });
    const pausedDbEntry = entry({
      id: 'mem_paused_1',
      title: 'Paused in-app memory',
      source: { kind: 'db_memory', sourceOfTruth: 'db_memory', memoryId: 'seed_paused' },
      injectionPaused: { since: now - 86_400_000, reason: 'never_used' },
      lastChange: { actor: 'eviction', operation: 'evict', timestamp: now - 1_000 },
      updatedAt: now - 7_200_000,
    });

    mockBackend({
      entries: [manualEntry, normalEntry, pausedDbEntry],
      journal: [],
    });
    render(<MemoryEntriesManager />);

    const rows = await screen.findAllByTestId('memory-entry-row');
    expect(rows).toHaveLength(3);

    const table = rows[0].closest('table');
    expect(table).not.toBeNull();
    const classTokens = table!.className.split(/\s+/);
    expect(classTokens).toContain('table-fixed');
    expect(table!.className).not.toMatch(/\bmin-w-/);

    const headers = Array.from(table!.querySelectorAll('thead th'));
    expect(headers).toHaveLength(5);
    expect(headers.map((th) => th.textContent?.trim())).toEqual([
      '',
      '条目',
      '状态',
      '类型',
      '更新 / 来源',
    ]);

    // 折叠规则（容器查询；jsdom 不求值，这里只钉住类名）：滚动容器是 @container；
    // 「类型」列在容器 < 520px 时隐藏，「更新 / 来源」列在 < 420px 时隐藏；勾选、条目、状态三列永不隐藏
    const wrapper = table!.closest('.overflow-auto');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className.split(/\s+/)).toContain('@container');
    const classList = (el: Element) => el.className.split(/\s+/);
    expect(classList(headers[3]!)).toContain('@max-[520px]:hidden');
    expect(classList(headers[4]!)).toContain('@max-[420px]:hidden');
    for (const index of [0, 1, 2]) expect(headers[index]!.className).not.toMatch(/hidden/);
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      expect(classList(cells[3]!)).toContain('@max-[520px]:hidden');
      expect(classList(cells[4]!)).toContain('@max-[420px]:hidden');
      for (const index of [0, 1, 2]) expect(cells[index]!.className).not.toMatch(/hidden/);
    }

    const rowFor = (title: string) => rows.find((row) => within(row).queryByText(title, { exact: true }))!;

    // Manual entry: merged 5th cell contains updated label + "手动添加", status cell keeps manual badge
    // （更新时间按机器时区取本地日期，期望值用组件同一个格式化函数算，换时区不红）
    const updatedLabelFor = (item: MemoryEntry) => formatMemoryEntryUpdatedAt(item.updatedAt);
    const manualRow = rowFor('Manual weekly report rule');
    const manualCells = manualRow.querySelectorAll('td');
    expect(manualCells).toHaveLength(5);
    expect(within(manualRow).getByTestId('memory-entry-manual-badge').textContent).toBe('手动添加');
    const manualUpdatedDivs = manualCells[4].querySelectorAll('div');
    expect(manualUpdatedDivs).toHaveLength(2);
    expect(manualUpdatedDivs[0].textContent?.trim()).toBe(updatedLabelFor(manualEntry));
    expect(manualUpdatedDivs[1].textContent?.trim()).toBe('手动添加');

    // Normal light_file candidate entry: merged 5th cell contains updated label + "记忆文件", candidate checkbox works
    const normalRow = rowFor('Normal light file memory');
    const normalCells = normalRow.querySelectorAll('td');
    expect(normalCells).toHaveLength(5);
    const normalUpdatedDivs = normalCells[4].querySelectorAll('div');
    expect(normalUpdatedDivs).toHaveLength(2);
    expect(normalUpdatedDivs[0].textContent?.trim()).toBe(updatedLabelFor(normalEntry));
    expect(normalUpdatedDivs[1].textContent?.trim()).toBe('记忆文件');
    const candidateCheckbox = within(normalRow).getByRole('checkbox') as HTMLInputElement;
    expect(candidateCheckbox.checked).toBe(false);
    fireEvent.click(candidateCheckbox);
    expect(candidateCheckbox.checked).toBe(true);

    // Paused db_memory entry with background write: merged 5th cell shows "应用内记忆", badges remain intact, row click selects it
    const pausedRow = rowFor('Paused in-app memory');
    const pausedCells = pausedRow.querySelectorAll('td');
    expect(pausedCells).toHaveLength(5);
    expect(within(pausedRow).getByTestId('memory-entry-paused-badge')).toBeTruthy();
    expect(within(pausedRow).getByTestId('memory-entry-background-badge')).toBeTruthy();
    const pausedUpdatedDivs = pausedCells[4].querySelectorAll('div');
    expect(pausedUpdatedDivs).toHaveLength(2);
    expect(pausedUpdatedDivs[0].textContent?.trim()).toBe(updatedLabelFor(pausedDbEntry));
    expect(pausedUpdatedDivs[1].textContent?.trim()).toBe('应用内记忆');

    fireEvent.click(pausedRow);
    await waitFor(() => expect(screen.getByTestId('memory-entry-paused-notice')).toBeTruthy());
  });
});
