// 空协作空间目录的可见会话数来自落库后的 SQL 计数；乐观更新早于落库，
// 所以归档/删除必须在 host 返回之后再通知侧栏重拉，而不是只靠 sessions 列表变化。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';
import { subscribeProjectSpaceList } from '../../../src/renderer/services/projectSpaceListEvents';

const mockDomainInvoke = vi.fn();

function makeSession(id: string): SessionWithMeta {
  return { id, title: id, createdAt: 0, updatedAt: 0, messageCount: 0, turnCount: 0 } as unknown as SessionWithMeta;
}

describe.each(['archive', 'delete'] as const)('%s 落库后通知空间目录重拉', (action) => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
      electronAPI: { invoke: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn() },
    };
    useSessionUIStore.setState({ filter: 'active' });
    useSessionStore.setState({ sessions: [makeSession('s1'), makeSession('s2')], currentSessionId: null, error: null });
  });

  it('host 返回前不通知，返回后通知一次', async () => {
    let finish: (value: unknown) => void = () => {};
    mockDomainInvoke.mockImplementation((_d: string, a: string) =>
      a === action ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ success: true, data: [] }));
    const seen: string[] = [];
    const off = subscribeProjectSpaceList((change) => seen.push(change));
    const store = useSessionStore.getState();
    const pending = action === 'archive' ? store.archiveSession('s1') : store.deleteSession('s1');
    await Promise.resolve();
    expect(seen).toEqual([]);
    finish({ success: true, data: {} });
    await pending;
    off();
    expect(seen).toEqual(['sessions']);
  });
});
