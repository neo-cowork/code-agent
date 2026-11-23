// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectWithActivity } from '../../../src/shared/contract/project';

const listMock = vi.fn();
vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjectsWithActivity: (...args: unknown[]) => listMock(...args),
}));

import { useEmptyCollaborationSpaces } from '../../../src/renderer/components/features/sidebar/useEmptyCollaborationSpaces';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

function row(visibleSessionCount: number): ProjectWithActivity {
  return {
    id: 'proj_space', name: 'space', status: 'idle', createdAt: 1, updatedAt: 1,
    activeTopicCount: 0, lastActivityAt: null, visibleSessionCount, spacePromotedAt: 1, workspacePath: null,
  };
}

const sess = (id: string) => ({
  id, title: id, modelConfig: { provider: 'openai', model: 'm' }, createdAt: 1, updatedAt: 1, messageCount: 1, turnCount: 1,
});

describe('useEmptyCollaborationSpaces', () => {
  beforeEach(() => {
    listMock.mockReset();
    useSessionStore.setState({ sessions: [sess('s1')] } as never);
  });

  it('reloads the catalog when the last visible session disappears', async () => {
    listMock.mockResolvedValueOnce([row(1)]).mockResolvedValue([row(0)]);
    const { result } = renderHook(() => useEmptyCollaborationSpaces());
    await waitFor(() => expect(result.current.spaces[0]?.visibleSessionCount).toBe(1));
    act(() => {
      useSessionStore.setState({ sessions: [] } as never);
    });
    await waitFor(() => expect(result.current.spaces[0]?.visibleSessionCount).toBe(0));
  });
});
