// @vitest-environment jsdom
// 归档撤销 + 搜索弹窗「包含已归档」：真实 Sidebar 树 + store，只在 IPC 边界放一个有状态的假 host
// （内存会话表，archive/unarchive/list 的语义与 host 一致，搜索按标题子串匹配）。
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../src/shared/contract';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, UI } from '../../../src/shared/constants';

interface Row { id: string; title: string; status: 'idle' | 'archived'; updatedAt: number }
const host = vi.hoisted(() => ({ rows: [] as Row[], calls: [] as string[], searchOptions: [] as unknown[] }));

vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
function toSession(row: Row): Session {
  return {
    id: row.id, title: row.title, createdAt: 1, updatedAt: row.updatedAt, workingDirectory: '/repo/demo',
    status: row.status, isArchived: row.status === 'archived',
    modelConfig: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
  } as unknown as Session;
}
function hostList(query: { includeArchived?: boolean; archivedOnly?: boolean } = {}): Session[] {
  return host.rows
    .filter((row) => (query.archivedOnly ? row.status === 'archived' : query.includeArchived || row.status !== 'archived'))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toSession);
}
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(async (channel: string, payload: { query: string; options?: { includeArchived?: boolean } }) => {
      if (channel !== IPC_CHANNELS.SESSION_SEARCH) return undefined;
      host.searchOptions.push(payload.options);
      const hits = host.rows.filter(
        (row) => row.title.includes(payload.query) && (payload.options?.includeArchived || row.status !== 'archived'),
      );
      return {
        query: payload.query, totalMatches: 0, sessionsWithMatches: 0, results: [], searchTime: 0, truncated: false,
        titleMatches: hits.map((row) => ({
          sessionId: row.id, title: row.title, updatedAt: row.updatedAt, ...(row.status === 'archived' ? { archived: true } : {}),
        })),
      };
    }),
    invokeDomain: vi.fn(async (domain: string, action: string, payload?: { archivedOnly?: boolean; includeArchived?: boolean }) =>
      domain === IPC_DOMAINS.SESSION && action === 'list' ? hostList(payload) : []),
    on: () => () => {},
  },
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { Sidebar } from '../../../src/renderer/components/Sidebar';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { resetSessionListLoadState } from '../../../src/renderer/stores/sessionListPagination';
import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';
import { useSessionArchiveUndoStore } from '../../../src/renderer/stores/sessionArchiveUndoStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';

const originalDomainAPI = window.domainAPI;
const TITLE = '整理周报素材';
const OTHER = '另一条会话';

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

beforeEach(() => {
  vi.useFakeTimers();
  host.rows = [
    { id: 's-a', title: TITLE, status: 'idle', updatedAt: 200 },
    { id: 's-b', title: OTHER, status: 'idle', updatedAt: 100 },
  ];
  host.calls = [];
  host.searchOptions = [];
  window.domainAPI = {
    ...originalDomainAPI,
    invoke: vi.fn(async (domain: string, action: string, payload?: { sessionId?: string }) => {
      if (domain !== IPC_DOMAINS.SESSION) return { success: true, data: [] };
      host.calls.push(action);
      if (action === 'list') return { success: true, data: hostList(payload as never) };
      if (action === 'archive' || action === 'unarchive') {
        const row = host.rows.find((item) => item.id === payload?.sessionId)!;
        row.status = action === 'archive' ? 'archived' : 'idle';
        return { success: true, data: toSession(row) };
      }
      return { success: true, data: [] };
    }),
  };
  useSessionStore.setState(useSessionStore.getInitialState());
  useSessionUIStore.setState(useSessionUIStore.getInitialState());
  useSessionArchiveUndoStore.setState({ pending: null });
  useAppStore.setState({ language: 'zh' });
  resetSessionListLoadState();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.domainAPI = originalDomainAPI;
});

async function mountLoaded() {
  render(<Sidebar />);
  await act(async () => { await useSessionStore.getState().loadSessions(); });
  await flush();
}
const rowArchiveButton = (title: string) => screen.getByRole('button', { name: `${zh.sidebarSession.archiveSession} ${title}` });
const rowVisible = (title: string) => screen.queryAllByText(title, { exact: false }).some((el) => !el.closest('[role="dialog"]'));

describe('归档后撤销（真实 Sidebar 树）', () => {
  it('点行图标归档 → 出现撤销 Toast → 撤销后行回到侧栏', async () => {
    await mountLoaded();
    expect(rowVisible(TITLE)).toBe(true);

    await act(async () => { fireEvent.click(rowArchiveButton(TITLE)); });
    await flush();

    expect(host.rows[0].status).toBe('archived');
    expect(screen.getByText(zh.sidebar.archivedToast.replace('{title}', TITLE))).toBeTruthy();
    expect(screen.queryByRole('button', { name: zh.sidebarSession.archiveSession + ' ' + TITLE })).toBeNull();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.common.undo })); });
    await flush();

    expect(host.calls).toContain('unarchive');
    expect(screen.getByRole('button', { name: `${zh.sidebarSession.archiveSession} ${TITLE}` })).toBeTruthy();
    expect(screen.queryByText(zh.sidebar.archivedToast.replace('{title}', TITLE))).toBeNull();
  });

  it('不点撤销：10 秒后 Toast 消失，会话仍是归档态；第二次归档替换上一条 Toast', async () => {
    await mountLoaded();
    await act(async () => { fireEvent.click(rowArchiveButton(TITLE)); });
    await flush();
    const first = zh.sidebar.archivedToast.replace('{title}', TITLE);
    expect(screen.getByText(first)).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(UI.ARCHIVE_UNDO_TOAST_DURATION - 1000); });
    await act(async () => { fireEvent.click(rowArchiveButton(OTHER)); });
    await flush();
    expect(screen.queryByText(first)).toBeNull();
    expect(screen.getByText(zh.sidebar.archivedToast.replace('{title}', OTHER))).toBeTruthy();

    // 旧 Toast 的计时不会误清新 Toast；新 Toast 满 10 秒后才消失
    await act(async () => { await vi.advanceTimersByTimeAsync(UI.ARCHIVE_UNDO_TOAST_DURATION - 500); });
    expect(screen.getByText(zh.sidebar.archivedToast.replace('{title}', OTHER))).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByText(zh.sidebar.archivedToast.replace('{title}', OTHER))).toBeNull();
    expect(host.rows.every((row) => row.status === 'archived')).toBe(true);
  });

  it('归档失败：不出 Toast', async () => {
    await mountLoaded();
    const base = window.domainAPI!.invoke as ReturnType<typeof vi.fn>;
    const original = base.getMockImplementation()!;
    base.mockImplementation(async (domain: string, action: string, payload?: unknown) =>
      action === 'archive' ? { success: false, error: { message: 'db locked' } } : original(domain, action, payload));
    await act(async () => { fireEvent.click(rowArchiveButton(TITLE)); });
    await flush();
    expect(useSessionArchiveUndoStore.getState().pending).toBeNull();
  });

  it('错过 Toast 后：搜索弹窗 → 空态提示 → 打开「包含已归档」→ 徽标 + 恢复 → 行回到侧栏并能被默认搜索找到', async () => {
    await mountLoaded();
    await act(async () => { fireEvent.click(rowArchiveButton(TITLE)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(UI.ARCHIVE_UNDO_TOAST_DURATION + 500); });
    expect(screen.queryByText(zh.sidebar.archivedToast.replace('{title}', TITLE))).toBeNull();

    await act(async () => { window.dispatchEvent(new Event('app:openSessionSearch')); });
    const input = screen.getByRole('textbox', { name: zh.sidebar.searchInputAria });
    await act(async () => { fireEvent.change(input, { target: { value: '周报' } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(zh.sidebar.searchArchivedHint)).toBeTruthy();
    const toggle = within(dialog).getByRole('switch', { name: zh.sidebar.searchIncludeArchived });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(host.searchOptions.every((o) => !(o as { includeArchived?: boolean })?.includeArchived)).toBe(true);

    await act(async () => { fireEvent.click(toggle); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(within(dialog).getByText(zh.sidebar.archivedBadge)).toBeTruthy();

    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: `${zh.sidebar.restoreSession} ${TITLE}` })); });
    await flush();
    expect(host.rows[0].status).toBe('idle');
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toContain('s-a');
    expect(within(dialog).queryByText(zh.sidebar.archivedBadge)).toBeNull();

    await act(async () => { fireEvent.click(within(dialog).getByRole('switch', { name: zh.sidebar.searchIncludeArchived })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(within(dialog).getByRole('option', { name: new RegExp(TITLE) })).toBeTruthy();
  });

  it('开关打开且查询为空：列出全部归档会话', async () => {
    host.rows[1].status = 'archived';
    await mountLoaded();
    await act(async () => { window.dispatchEvent(new Event('app:openSessionSearch')); });
    const dialog = screen.getByRole('dialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('switch', { name: zh.sidebar.searchIncludeArchived })); });
    await flush();
    expect(within(dialog).getByText(zh.sidebar.archivedSessionsHeading)).toBeTruthy();
    expect(within(dialog).getByRole('option', { name: new RegExp(OTHER) })).toBeTruthy();
    expect(within(dialog).queryByRole('option', { name: new RegExp(TITLE) })).toBeNull();
  });
});
