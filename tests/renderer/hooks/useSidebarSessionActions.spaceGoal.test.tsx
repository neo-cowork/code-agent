// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { useSidebarSessionActions } from '../../../src/renderer/components/features/sidebar/useSidebarSessionActions';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn(async () => ({})) },
}));
afterEach(() => vi.clearAllMocks());

describe('start goal from a folderless space', () => {
  it('creates the session with the space projectId and no directory', async () => {
    const createSession = vi.fn(async () => ({ id: 'goal-session', title: 'g', projectId: 'proj_space', createdAt: 1, updatedAt: 1 }));
    const params = {
      collapseTimersRef: { current: {} }, setCollapsingWorkspaces: vi.fn(), setWorkspaceExpanded: vi.fn(),
      isCreatingSession: false, creatingWorkspaceKey: null, setCreatingSessionMode: vi.fn(), setCreatingWorkspaceKey: vi.fn(),
      createSession, clearPlanningState: vi.fn(), setWorkingDirectory: vi.fn(), multiSelectMode: false, toggleSelection: vi.fn(),
      searchQuery: '', messageSearchHitsBySessionId: {}, setPendingSearchJump: vi.fn(), currentSessionId: null,
      switchSession: vi.fn(async () => undefined), unarchiveSession: vi.fn(async () => undefined), archiveSession: vi.fn(async () => undefined),
      openWorkspacePreview: vi.fn(), setProjectMetaById: vi.fn(), t: zh,
    } as unknown as Parameters<typeof useSidebarSessionActions>[0];
    const view = renderHook(() => useSidebarSessionActions(params));
    await act(async () => {
      await view.result.current.handleStartProjectGoal(
        { id: 'goal-1', title: '写周报', status: 'active' } as never,
        'project:proj_space',
        undefined,
        'proj_space',
      );
    });
    expect(createSession).toHaveBeenCalledWith(expect.any(String), { workingDirectory: null, projectId: 'proj_space' });
  });
});
