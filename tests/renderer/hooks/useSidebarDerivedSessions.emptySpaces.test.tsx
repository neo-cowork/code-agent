// @vitest-environment jsdom
// 侧栏空空间：只在 host 统计该空间确实 0 会话时画空组；空间集合变化事件触发重拉。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// ---- store 状态（selector-mock 读取，测试内可变更后 rerender）----
const state = vi.hoisted(() => ({
  session: {
    sessions: [] as any[],
    currentSessionId: null as string | null,
    sessionRuntimes: new Map<string, unknown>(),
    backgroundSessions: [] as any[],
    pendingUserQuestionsBySessionId: new Map<string, unknown>(),
  },
  ui: {
    searchQuery: '',
    sessionStatusFilter: 'all' as const,
    trajectoryTierFilter: 'all' as const,
    trajectoryFailureFilter: 'all' as const,
    trajectoryReviewFilter: 'all' as const,
  },
  app: {
    pendingPermissionRequest: null as unknown,
    pendingPermissionSessionId: null as string | null,
    queuedPermissionRequests: [] as unknown[],
  },
  backgroundTask: { tasks: [] as unknown[] },
  workflow: { runs: [] as unknown[] },
  task: { sessionStates: {} as Record<string, { status: string }> },
}));

const projectClient = vi.hoisted(() => ({
  SPACES_CHANGED_EVENT: 'neo:spaces-changed',
  listProjectsWithActivity: vi.fn(async (): Promise<any[]> => []),
  getProjectDetail: vi.fn(async (projectId: string) => ({
    project: { id: projectId, name: 'P', status: 'active', description: '', updatedAt: 1 },
    goals: [],
    roles: [],
    sessionIds: ['s1'],
  })),
  getProjectArtifacts: vi.fn(async () => []),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: (s: unknown) => unknown) => sel(state.session),
}));
vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: (sel: (s: unknown) => unknown) => sel(state.ui),
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel(state.app),
}));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (sel: (s: unknown) => unknown) => sel(state.backgroundTask),
}));
vi.mock('../../../src/renderer/stores/workflowStore', () => ({
  useWorkflowStore: (sel: (s: unknown) => unknown) => sel(state.workflow),
}));
vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (sel: (s: unknown) => unknown) => sel(state.task),
}));
vi.mock('../../../src/renderer/services/projectClient', () => projectClient);
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { useSidebarDerivedSessions } from '../../../src/renderer/components/features/sidebar/useSidebarDerivedSessions';


beforeEach(() => {
  vi.clearAllMocks();
  state.session.sessions = [];
  state.session.sessionRuntimes = new Map();
  state.session.backgroundSessions = [];
  state.task.sessionStates = {};
});
afterEach(() => vi.clearAllMocks());

const space = (id: string, sessionCount: number) => ({ id, name: id, workspacePath: null, status: 'active', activeTopicCount: 0, sessionCount, lastActivityAt: null });

describe('sidebar empty space groups', () => {
  it('draws an empty group only for a space the host counts as 0 sessions (not for one whose sessions are just off the loaded page)', async () => {
    projectClient.listProjectsWithActivity.mockResolvedValue([space('proj_empty', 0), space('proj_paged_out', 7)]);
    const { result } = renderHook(() => useSidebarDerivedSessions({ canOpenSessionReplay: false }));
    await waitFor(() => expect(result.current.workspaceGroupedSessions.some((g) => g.projectId === 'proj_empty')).toBe(true));
    expect(result.current.workspaceGroupedSessions.some((g) => g.projectId === 'proj_paged_out')).toBe(false);
  });

  it('refetches the space list when spaces change (archive/delete/create) so a stale group disappears', async () => {
    projectClient.listProjectsWithActivity.mockResolvedValue([space('proj_empty', 0)]);
    const { result } = renderHook(() => useSidebarDerivedSessions({ canOpenSessionReplay: false }));
    await waitFor(() => expect(result.current.workspaceGroupedSessions.some((g) => g.projectId === 'proj_empty')).toBe(true));
    projectClient.listProjectsWithActivity.mockResolvedValue([]);
    act(() => { window.dispatchEvent(new Event('neo:spaces-changed')); });
    await waitFor(() => expect(result.current.workspaceGroupedSessions.some((g) => g.projectId === 'proj_empty')).toBe(false));
  });
});
