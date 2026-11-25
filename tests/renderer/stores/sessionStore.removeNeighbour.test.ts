// ============================================================================
// deleteSession / archiveSession 落点回归测试：
// 删除或归档当前会话后，落到同一项目组内相邻会话（按 updatedAt 降序：先下一条，
// 否则上一条），组内无剩余会话时退回空白态，绝不跳到全局第一条（跨项目串台）。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';

const mockDomainInvoke = vi.fn();

function makeSession(
  id: string,
  updatedAt: number,
  projectId: string,
  workingDirectory = `/projects/${projectId}`,
): SessionWithMeta {
  return {
    id,
    title: id,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    projectId,
    workingDirectory,
    type: 'chat',
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
    turnCount: 0,
  };
}

function setupMockDomain(fixtures: SessionWithMeta[]): void {
  const byId = new Map(fixtures.map((s) => [s.id, s]));
  mockDomainInvoke.mockImplementation((_domain: string, action: string, payload?: { sessionId?: string }) => {
    if (action === 'archive' || action === 'delete') {
      return Promise.resolve({ success: true, data: {} });
    }
    if (action === 'load') {
      const found = payload?.sessionId ? byId.get(payload.sessionId) : undefined;
      return Promise.resolve({ success: true, data: found ? { ...found, messages: [], todos: [] } : null });
    }
    if (action === 'getSessionTasks') {
      return Promise.resolve({ success: true, data: [] });
    }
    return Promise.resolve({ success: true, data: [] });
  });
}

describe('sessionStore deleteSession / archiveSession same-project landing', () => {
  const projectBFirst = makeSession('b-top', 500, 'proj-b');
  const projectANewest = makeSession('a-newest', 400, 'proj-a');
  const projectAMiddle = makeSession('a-middle', 300, 'proj-a');
  const projectAOlder = makeSession('a-older', 200, 'proj-a');
  const projectBSecond = makeSession('b-second', 100, 'proj-b');

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
      electronAPI: { invoke: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn() },
    };
    useSessionUIStore.setState({ filter: 'active' });
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      messages: [],
      todos: [],
      sessionTasks: [],
      streamSnapshot: null,
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(['archiveSession', 'deleteSession'] as const)('%s', (action) => {
    it('lands on the next-older session in the same project, never the global first row from another project', async () => {
      const all = [projectBFirst, projectANewest, projectAMiddle, projectAOlder, projectBSecond];
      setupMockDomain(all);
      useSessionStore.setState({ sessions: all, currentSessionId: projectAMiddle.id });

      await useSessionStore.getState()[action](projectAMiddle.id);

      expect(useSessionStore.getState().currentSessionId).toBe(projectAOlder.id);
      expect(useSessionStore.getState().sessions.find((s) => s.id === projectAOlder.id)?.projectId).toBe('proj-a');
    });

    it('picks the next-older neighbour when removing the newest session in the project (not the global first row)', async () => {
      const all = [projectBFirst, projectAOlder, projectANewest, projectAMiddle];
      setupMockDomain(all);
      useSessionStore.setState({ sessions: all, currentSessionId: projectANewest.id });

      await useSessionStore.getState()[action](projectANewest.id);

      expect(useSessionStore.getState().currentSessionId).toBe(projectAMiddle.id);
    });

    it('falls back to the nearest newer session in the same project when removing the oldest session', async () => {
      const all = [projectBFirst, projectANewest, projectAMiddle, projectAOlder];
      setupMockDomain(all);
      useSessionStore.setState({ sessions: all, currentSessionId: projectAOlder.id });

      await useSessionStore.getState()[action](projectAOlder.id);

      expect(useSessionStore.getState().currentSessionId).toBe(projectAMiddle.id);
    });

    it('clears to blank state (currentSessionId = null) when removing the only session in its project, even when other projects exist', async () => {
      const all = [projectBFirst, projectAMiddle, projectBSecond];
      setupMockDomain(all);
      const syncAgentSpy = vi.spyOn(useAppStore.getState(), 'syncActiveAgentForSession');
      const syncWorkbenchSpy = vi.spyOn(useAppStore.getState(), 'syncWorkbenchForSession');
      useSessionStore.setState({
        sessions: all,
        currentSessionId: projectAMiddle.id,
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 } as never],
      });

      await useSessionStore.getState()[action](projectAMiddle.id);

      const state = useSessionStore.getState();
      expect(state.currentSessionId).toBeNull();
      expect(state.messages).toEqual([]);
      expect(state.todos).toEqual([]);
      expect(state.sessionTasks).toEqual([]);
      expect(state.streamSnapshot).toBeNull();
      expect(syncAgentSpy).toHaveBeenCalledWith(null);
      expect(syncWorkbenchSpy).toHaveBeenCalledWith(null);
    });
  });

  it('archiveSession skips a neighbour that was concurrently archived while IPC was in flight', async () => {
    const all = [projectBFirst, projectANewest, projectAMiddle, projectAOlder];
    let resolveFirstArchive: (value: unknown) => void = () => {};
    let archiveCall = 0;
    const byId = new Map(all.map((s) => [s.id, s]));
    mockDomainInvoke.mockImplementation((_domain: string, action: string, payload?: { sessionId?: string }) => {
      if (action === 'archive') {
        archiveCall += 1;
        if (archiveCall === 1) {
          return new Promise((resolve) => {
            resolveFirstArchive = resolve;
          });
        }
        return Promise.resolve({ success: true, data: {} });
      }
      if (action === 'load') {
        const found = payload?.sessionId ? byId.get(payload.sessionId) : undefined;
        return Promise.resolve({ success: true, data: found ? { ...found, messages: [], todos: [] } : null });
      }
      return Promise.resolve({ success: true, data: [] });
    });

    useSessionStore.setState({ sessions: all, currentSessionId: projectAMiddle.id });

    const p1 = useSessionStore.getState().archiveSession(projectAMiddle.id);
    const p2 = useSessionStore.getState().archiveSession(projectAOlder.id);
    resolveFirstArchive({ success: true, data: {} });
    await Promise.all([p1, p2]);

    expect(useSessionStore.getState().currentSessionId).toBe(projectANewest.id);
  });
});
