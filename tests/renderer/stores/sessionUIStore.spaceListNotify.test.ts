// 侧栏删除走 sessionUIStore 自己的 deleteSession（softDelete 乐观移除，5 秒后 confirmDelete 才落库），
// 不经 sessionStore.deleteSession。空协作空间目录必须在真正落库之后被通知重拉。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';
import { subscribeProjectSpaceList } from '../../../src/renderer/services/projectSpaceListEvents';

const mockDomainInvoke = vi.fn();

function makeSession(id: string): SessionWithMeta {
  return { id, title: id, createdAt: 0, updatedAt: 0, messageCount: 0, turnCount: 0 } as unknown as SessionWithMeta;
}

describe('sidebar soft delete → space catalog notification', () => {
  let events: string[];
  let resolvers: Array<(value: unknown) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    resolvers = [];
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
      electronAPI: { invoke: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn() },
    };
    mockDomainInvoke.mockImplementation((_d: string, action: string, payload?: { sessionId?: string }) => {
      if (action === 'delete') {
        events.push(`invoke:${payload?.sessionId}`);
        return new Promise((resolve) => {
          resolvers.push((value) => {
            events.push(`resolved:${payload?.sessionId}`);
            resolve(value);
          });
        });
      }
      return Promise.resolve({ success: true, data: [] });
    });
    useSessionStore.setState({
      sessions: [makeSession('a'), makeSession('b'), makeSession('c')],
      currentSessionId: null,
      error: null,
    });
    useSessionUIStore.setState({ pendingDelete: null });
  });

  it('confirmDelete: notifies only after the delete invoke resolved, not on optimistic removal', async () => {
    const off = subscribeProjectSpaceList((change) => events.push(`notify:${change}`));
    useSessionUIStore.getState().softDelete(['a']);
    expect(events).toEqual([]);
    const confirm = useSessionUIStore.getState().confirmDelete();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    expect(events).toEqual(['invoke:a']);
    resolvers[0]({ success: true, data: {} });
    await confirm;
    off();
    expect(events).toEqual(['invoke:a', 'resolved:a', 'notify:sessions']);
  });

  it('previous-batch flush: second softDelete persists the first batch and notifies after it resolved', async () => {
    const off = subscribeProjectSpaceList((change) => events.push(`notify:${change}`));
    useSessionUIStore.getState().softDelete(['a']);
    useSessionUIStore.getState().softDelete(['b']);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    expect(events).toEqual(['invoke:a']);
    resolvers[0]({ success: true, data: {} });
    await vi.waitFor(() => expect(events).toContain('notify:sessions'));
    off();
    expect(events).toEqual(['invoke:a', 'resolved:a', 'notify:sessions']);
    useSessionUIStore.getState().undoDelete();
  });
});
