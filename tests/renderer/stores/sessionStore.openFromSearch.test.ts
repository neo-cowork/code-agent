// @vitest-environment jsdom
// 从搜索结果打开一个不在已加载分页窗口里的老会话：
// ② 打开后 sessions 里要有它（顶栏标题按 id 在 sessions 里查）；
// 翻页 offset 不被这个外来行挤偏；静默刷新重取窗口后它仍在。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_LIST_PAGE_SIZE } from '../../../src/shared/constants';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';

const mockDomainInvoke = vi.fn();
const rows = Array.from({ length: 120 }, (_, i) => ({
  id: `s-${i + 1}`,
  title: `title ${i + 1}`,
  updatedAt: 1_000_000 - i * 1000,
  createdAt: 1,
  modelConfig: { provider: 'zhipu', model: 'glm-5' },
}));

describe('open a session found by search that is outside the loaded page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
      electronAPI: { invoke: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn() },
    };
    useSessionUIStore.setState({ filter: 'active' });
    useSessionStore.setState({
      sessions: [], currentSessionId: null, error: null, isLoading: false,
      hasOlderSessions: false, isLoadingOlderSessions: false,
    });
    mockDomainInvoke.mockImplementation(async (_d: string, action: string, payload?: { limit?: number; offset?: number; sessionId?: string }) => {
      if (action === 'list') {
        const { limit = SESSION_LIST_PAGE_SIZE, offset = 0 } = payload ?? {};
        return { success: true, data: rows.slice(offset, offset + limit) };
      }
      if (action === 'load') {
        const row = rows.find((r) => r.id === payload?.sessionId);
        return { success: true, data: { ...row, messages: [], todos: [] } };
      }
      return { success: true, data: [] };
    });
  });

  it('adds the session to sessions with its title, keeps paging offsets and survives a silent refresh', async () => {
    await useSessionStore.getState().loadSessions();
    expect(useSessionStore.getState().sessions).toHaveLength(50);

    await useSessionStore.getState().switchSession('s-58');
    const opened = useSessionStore.getState().sessions.find((s) => s.id === 's-58');
    expect(opened?.title).toBe('title 58');
    expect(useSessionStore.getState().currentSessionId).toBe('s-58');

    // 翻页 offset 仍是 50（外来行不算窗口），不会漏掉 s-51
    await useSessionStore.getState().loadOlderSessions();
    const listCalls = mockDomainInvoke.mock.calls.filter(([, action]) => action === 'list');
    expect(listCalls[listCalls.length - 1][2]).toMatchObject({ offset: 50 });
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toContain('s-51');

    // 静默刷新按窗口（100）重取；s-58 此时已在窗口里，不重复
    await useSessionStore.getState().loadSessions({ silent: true });
    const ids = useSessionStore.getState().sessions.map((s) => s.id);
    expect(ids.filter((id) => id === 's-58')).toHaveLength(1);
  });

  it('keeps an outside-window session through a silent refresh', async () => {
    await useSessionStore.getState().loadSessions();
    await useSessionStore.getState().switchSession('s-110');
    await useSessionStore.getState().loadSessions({ silent: true });
    const ids = useSessionStore.getState().sessions.map((s) => s.id);
    expect(ids).toContain('s-110');
    const last = mockDomainInvoke.mock.calls.filter(([, a]) => a === 'list').pop();
    expect(last?.[2]).toMatchObject({ offset: 0, limit: 50 });
  });
});
