// @vitest-environment jsdom
// 归档撤销 + 搜索弹窗「包含已归档」：真实 Sidebar 树 + store，只在 IPC 边界放一个有状态的假 host
// （内存会话表，archive/unarchive/list 的语义与 host 一致，搜索按标题子串匹配）。
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../src/shared/contract';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, UI } from '../../../src/shared/constants';

interface Row { id: string; title: string; status: 'idle' | 'archived'; updatedAt: number; dir?: string }
const host = vi.hoisted(() => ({
  rows: [] as Row[], calls: [] as string[], searchOptions: [] as unknown[],
  listPayloads: [] as Array<Record<string, unknown>>,
  /** 第 N 次 session list 调用（从 1 起）挂起，直到 release() */
  holdListCall: 0, release: null as null | (() => void), gate: null as null | Promise<void>,
}));

vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
function toSession(row: Row): Session {
  return {
    id: row.id, title: row.title, createdAt: 1, updatedAt: row.updatedAt, workingDirectory: row.dir ?? '/repo/demo',
    status: row.status, isArchived: row.status === 'archived',
    modelConfig: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
  } as unknown as Session;
}
function hostList(query: { includeArchived?: boolean; archivedOnly?: boolean; limit?: number; offset?: number; projectScope?: { workingDirectory?: string } } = {}): Session[] {
  const all = host.rows
    .filter((row) => (query.archivedOnly ? row.status === 'archived' : query.includeArchived || row.status !== 'archived'))
    // 与 host SQL 一致：项目收窄发生在分页之前
    .filter((row) => !query.projectScope?.workingDirectory || (row.dir ?? '/repo/demo') === query.projectScope.workingDirectory)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toSession);
  return all.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? all.length));
}
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(async (channel: string, payload: { query: string; options?: { includeArchived?: boolean; projectScope?: { workingDirectory?: string } } }) => {
      if (channel !== IPC_CHANNELS.SESSION_SEARCH) return undefined;
      host.searchOptions.push(payload.options);
      const hits = host.rows.filter(
        (row) =>
          row.title.includes(payload.query) &&
          (payload.options?.includeArchived || row.status !== 'archived') &&
          (!payload.options?.projectScope?.workingDirectory || (row.dir ?? '/repo/demo') === payload.options.projectScope.workingDirectory),
      );
      return {
        query: payload.query, totalMatches: 0, sessionsWithMatches: 0, results: [], searchTime: 0, truncated: false,
        titleMatches: hits.map((row) => ({
          sessionId: row.id, title: row.title, updatedAt: row.updatedAt, ...(row.status === 'archived' ? { archived: true } : {}),
        })),
      };
    }),
    invokeDomain: vi.fn(async (domain: string, action: string, payload?: { archivedOnly?: boolean; includeArchived?: boolean }) => {
      if (domain !== IPC_DOMAINS.SESSION || action !== 'list') return [];
      host.listPayloads.push({ ...payload });
      const result = hostList(payload);
      if (host.holdListCall && host.listPayloads.length === host.holdListCall) await host.gate;
      return result;
    }),
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
import { interpolatePlural } from '../../../src/renderer/i18n/interpolate';

const originalDomainAPI = window.domainAPI;
type DomainInvoke = (domain: string, action: string, payload?: unknown) => Promise<unknown>;
const domainInvoke = vi.fn<DomainInvoke>();
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
  host.listPayloads = [];
  host.holdListCall = 0;
  host.gate = null;
  window.domainAPI = {
    ...originalDomainAPI,
    invoke: domainInvoke as unknown as NonNullable<typeof window.domainAPI>['invoke'],
  };
  domainInvoke.mockReset();
  domainInvoke.mockImplementation(async (domain, action, rawPayload) => {
      const payload = rawPayload as { sessionId?: string; updatedAt?: number } | undefined;
      if (domain !== IPC_DOMAINS.SESSION) return { success: true, data: [] };
      host.calls.push(action);
      if (action === 'list') return { success: true, data: hostList(payload as never) };
      if (action === 'archive' || action === 'unarchive') {
        const row = host.rows.find((item) => item.id === payload?.sessionId)!;
        row.status = action === 'archive' ? 'archived' : 'idle';
        // 与 host 一致：归档/取消归档都会刷新 updated_at；取消归档可带回原时间
        row.updatedAt = action === 'unarchive' && payload?.updatedAt !== undefined ? payload.updatedAt : 9_000 + host.calls.length;
        return { success: true, data: toSession(row) };
      }
      return { success: true, data: [] };
  });
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
    const original = domainInvoke.getMockImplementation()!;
    domainInvoke.mockImplementation(async (domain, action, payload) =>
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

  it('撤销回到归档前的原位置：侧栏行顺序前后一致（归档会刷新 updated_at，撤销带回原值）', async () => {
    host.rows = [
      { id: 'o-a', title: '第一条任务', status: 'idle', updatedAt: 300 },
      { id: 'o-b', title: '第二条任务', status: 'idle', updatedAt: 200 },
      { id: 'o-c', title: '第三条任务', status: 'idle', updatedAt: 100 },
    ];
    await mountLoaded();
    const order = () => screen.getAllByRole('button', { name: new RegExp(`^${zh.sidebarSession.archiveSession} `) }).map((el) => el.getAttribute('aria-label'));
    const before = order();
    expect(before).toHaveLength(3);

    await act(async () => { fireEvent.click(rowArchiveButton('第二条任务')); });
    await flush();
    expect(order()).toHaveLength(2);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.common.undo })); });
    await flush();

    expect(order()).toEqual(before);
    expect(host.rows.find((row) => row.id === 'o-b')!.updatedAt).toBe(200);
  });

  it('空查询归档列表分页：第 51 条也能加载出来并恢复，恢复后回到侧栏', async () => {
    host.rows = Array.from({ length: 120 }, (_, i) => ({
      id: `arch-${i}`, title: `归档任务 ${String(i).padStart(3, '0')}`, status: 'archived' as const, updatedAt: 10_000 - i,
    }));
    await mountLoaded();
    await act(async () => { window.dispatchEvent(new Event('app:openSessionSearch')); });
    const dialog = screen.getByRole('dialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('switch', { name: zh.sidebar.searchIncludeArchived })); });
    await flush();

    expect(within(dialog).getAllByRole('option')).toHaveLength(50);
    expect(within(dialog).queryByRole('option', { name: /归档任务 050/ })).toBeNull();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.sidebar.loadMoreArchived })); });
    await flush();
    expect(within(dialog).getAllByRole('option')).toHaveLength(100);
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.sidebar.loadMoreArchived })); });
    await flush();
    expect(within(dialog).getAllByRole('option')).toHaveLength(120);
    expect(within(dialog).queryByRole('button', { name: zh.sidebar.loadMoreArchived })).toBeNull();

    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: `${zh.sidebar.restoreSession} 归档任务 050` })); });
    await flush();
    expect(host.rows.find((row) => row.id === 'arch-50')!.status).toBe('idle');
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toContain('arch-50');
    // 空查询只列归档会话：恢复的那条从列表消失，其余 119 条仍在
    expect(within(dialog).getAllByRole('option')).toHaveLength(119);
    expect(within(dialog).queryByRole('option', { name: /归档任务 050/ })).toBeNull();
  });

  it('当前项目范围 + 包含已归档：只列/只搜本项目的归档会话', async () => {
    host.rows = [
      { id: 'cur', title: '本项目进行中', status: 'idle', updatedAt: 500, dir: '/repo/demo' },
      { id: 'a-demo', title: '周报 本项目归档', status: 'archived', updatedAt: 400, dir: '/repo/demo' },
      { id: 'a-other', title: '周报 别的项目归档', status: 'archived', updatedAt: 300, dir: '/repo/other' },
    ];
    await mountLoaded();
    await act(async () => { useSessionStore.setState({ currentSessionId: 'cur' }); });
    await act(async () => { window.dispatchEvent(new Event('app:openSessionSearch')); });
    const dialog = screen.getByRole('dialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('switch', { name: zh.sidebar.searchIncludeArchived })); });
    await flush();
    // 「全部」范围：两个归档都在
    expect(within(dialog).getAllByRole('option')).toHaveLength(2);

    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.sidebar.scopeCurrentProject })); });
    await flush();
    expect(within(dialog).getAllByRole('option').map((el) => el.textContent)).toEqual([expect.stringContaining('周报 本项目归档')]);

    await act(async () => { fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '周报' } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    const options = within(dialog).getAllByRole('option').map((el) => el.textContent ?? '');
    expect(options).toHaveLength(1);
    expect(options[0]).toContain('周报 本项目归档');
    expect(options[0]).toContain(zh.sidebar.archivedBadge);
    expect(host.searchOptions.at(-1)).toMatchObject({ includeArchived: true, projectScope: { workingDirectory: '/repo/demo' } });
  });

  it('本项目归档列表：项目收窄在分页之前，本项目归档不在全局最近 50 条里也能列出并恢复', async () => {
    host.rows = [
      { id: 'cur', title: '本项目进行中', status: 'idle', updatedAt: 9_000, dir: '/repo/demo' },
      ...Array.from({ length: 60 }, (_, i) => ({ id: `o-${i}`, title: `别项目归档 ${i}`, status: 'archived' as const, updatedAt: 8_000 - i, dir: '/repo/other' })),
      { id: 'mine', title: '我的旧归档', status: 'archived', updatedAt: 10, dir: '/repo/demo' },
    ];
    await mountLoaded();
    await act(async () => { useSessionStore.setState({ currentSessionId: 'cur' }); });
    await act(async () => { window.dispatchEvent(new Event('app:openSessionSearch')); });
    const dialog = screen.getByRole('dialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('switch', { name: zh.sidebar.searchIncludeArchived })); });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.sidebar.scopeCurrentProject })); });
    await flush();
    expect(within(dialog).getAllByRole('option').map((el) => el.textContent)).toEqual([expect.stringContaining('我的旧归档')]);
    expect(host.listPayloads.at(-1)).toMatchObject({ archivedOnly: true, projectScope: { workingDirectory: '/repo/demo' } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: `${zh.sidebar.restoreSession} 我的旧归档` })); });
    await flush();
    expect(host.rows.find((row) => row.id === 'mine')!.status).toBe('idle');
  });

  it('切换范围后旧范围的归档行立即作废，不能再点恢复（不会误恢复别的项目的会话）', async () => {
    host.rows = [
      { id: 'cur', title: '本项目进行中', status: 'idle', updatedAt: 9_000, dir: '/repo/demo' },
      { id: 'a-demo', title: '本项目归档', status: 'archived', updatedAt: 400, dir: '/repo/demo' },
      { id: 'a-other', title: '别项目归档', status: 'archived', updatedAt: 300, dir: '/repo/other' },
    ];
    await mountLoaded();
    await act(async () => { useSessionStore.setState({ currentSessionId: 'cur' }); });
    await act(async () => { window.dispatchEvent(new Event('app:openSessionSearch')); });
    const dialog = screen.getByRole('dialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('switch', { name: zh.sidebar.searchIncludeArchived })); });
    await flush();
    expect(within(dialog).getByRole('button', { name: `${zh.sidebar.restoreSession} 别项目归档` })).toBeTruthy();

    // 新范围的请求挂起（下一次 list 调用）：回来之前旧行不能还在
    host.gate = new Promise<void>((resolve) => { host.release = resolve; });
    host.holdListCall = host.listPayloads.length + 1;
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.sidebar.scopeCurrentProject })); });
    await flush();
    expect(within(dialog).queryByRole('button', { name: `${zh.sidebar.restoreSession} 别项目归档` })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: `${zh.sidebar.restoreSession} 本项目归档` })).toBeNull();
    await act(async () => { host.release?.(); });
    await flush();
    expect(within(dialog).getByRole('button', { name: `${zh.sidebar.restoreSession} 本项目归档` })).toBeTruthy();
    expect(host.rows.find((row) => row.id === 'a-other')!.status).toBe('archived');
  });

  it('已作废的翻页请求晚到，不会抬高 offset（下一次加载更多不跳页）', async () => {
    host.rows = [
      { id: 'cur', title: '本项目进行中', status: 'idle', updatedAt: 99_000, dir: '/repo/demo' },
      ...Array.from({ length: 120 }, (_, i) => ({ id: `d-${i}`, title: `归档 ${String(i).padStart(3, '0')}`, status: 'archived' as const, updatedAt: 10_000 - i, dir: '/repo/demo' })),
    ];
    await mountLoaded();
    await act(async () => { useSessionStore.setState({ currentSessionId: 'cur' }); });
    await act(async () => { window.dispatchEvent(new Event('app:openSessionSearch')); });
    const dialog = screen.getByRole('dialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('switch', { name: zh.sidebar.searchIncludeArchived })); });
    await flush();
    expect(within(dialog).getAllByRole('option')).toHaveLength(50);

    // 「加载更多」请求挂起 → 切到当前项目（旧请求作废）→ 新范围首页到达 → 旧请求才晚到
    host.gate = new Promise<void>((resolve) => { host.release = resolve; });
    host.holdListCall = host.listPayloads.length + 1;
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.sidebar.loadMoreArchived })); });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.sidebar.scopeCurrentProject })); });
    await flush();
    expect(within(dialog).getAllByRole('option')).toHaveLength(50);
    await act(async () => { host.release?.(); });
    await flush();

    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.sidebar.loadMoreArchived })); });
    await flush();
    expect(host.listPayloads.at(-1)).toMatchObject({ offset: 50 });
    expect(within(dialog).getAllByRole('option')).toHaveLength(100);
  });

  it('删除撤销与归档撤销同屏：两个 Toast 的撤销按钮都可点（锚点错开）', async () => {
    await mountLoaded();
    await act(async () => { useSessionUIStore.getState().softDelete(['s-b']); });
    await act(async () => { fireEvent.click(rowArchiveButton(TITLE)); });
    await flush();
    const deleteToast = screen.getByText(interpolatePlural(zh.sidebar.deletedCount, 1)).closest('.fixed')!;
    const archiveToast = screen.getByText(zh.sidebar.archivedToast.replace('{title}', TITLE)).closest('.fixed')!;
    const anchor = (el: Element) => [...el.classList].find((c) => /^bottom-\d+$/.test(c));
    expect(anchor(deleteToast)).toBeTruthy();
    expect(anchor(archiveToast)).toBeTruthy();
    expect(anchor(deleteToast)).not.toBe(anchor(archiveToast));
  });
});
