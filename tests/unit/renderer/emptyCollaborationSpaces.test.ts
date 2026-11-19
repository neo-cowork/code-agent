import { describe, expect, it } from 'vitest';
import type { ProjectWithActivity } from '../../../src/shared/contract/project';
import {
  hideArchivedCollaborationSpaces,
  mergeEmptyCollaborationSpaces,
  overlaySpaceCatalogMeta,
} from '../../../src/renderer/utils/emptyCollaborationSpaces';
import { groupByWorkspace, type WorkspaceGroup } from '../../../src/renderer/utils/workspaceGrouping';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

function space(overrides: Partial<ProjectWithActivity> & Pick<ProjectWithActivity, 'id'>): ProjectWithActivity {
  return {
    name: overrides.id,
    status: 'idle',
    createdAt: 1,
    updatedAt: 10,
    activeTopicCount: 0,
    lastActivityAt: null,
    visibleSessionCount: 0,
    spacePromotedAt: 5,
    workspacePath: null,
    ...overrides,
  };
}

function session(overrides: Partial<SessionWithMeta>): SessionWithMeta {
  return {
    id: 'session-1',
    title: '已有会话',
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 20,
    messageCount: 1,
    turnCount: 1,
    ...overrides,
  };
}

describe('mergeEmptyCollaborationSpaces', () => {
  it('adds a folderless empty space and skips a space that still has visible sessions', () => {
    const groups = groupByWorkspace(
      [session({ projectId: 'proj_loaded', workingDirectory: '/work/loaded' })],
      '快速对话',
      '项目',
    );
    const merged = mergeEmptyCollaborationSpaces(groups, [
      space({ id: 'proj_empty', name: '周报', updatedAt: 30 }),
      space({ id: 'proj_offpage', name: '不在这一页', visibleSessionCount: 2 }),
      space({ id: 'proj_loaded', name: '已加载', visibleSessionCount: 0 }),
    ]);

    const empty = merged.find((group) => group.projectId === 'proj_empty');
    expect(empty).toMatchObject({
      key: 'project:proj_empty',
      name: '周报',
      path: undefined,
      paths: [],
      sessions: [],
      latestActivityAt: 30,
    });
    expect(merged.some((group) => group.projectId === 'proj_offpage')).toBe(false);
    expect(merged.filter((group) => group.projectId === 'proj_loaded')).toHaveLength(1);
  });

  it('keeps the uncategorized bucket last', () => {
    const groups = groupByWorkspace(
      [session({ id: 'chat-1', projectId: 'proj_unsorted', workingDirectory: undefined, updatedAt: 100 })],
      '快速对话',
      '项目',
    );
    const merged = mergeEmptyCollaborationSpaces(groups, [
      space({ id: 'proj_empty', name: '周报', updatedAt: 1 }),
    ]);
    expect(merged.at(-1)?.isUncategorized).toBe(true);
    expect(merged[0]?.projectId).toBe('proj_empty');
  });
});

describe('space catalog meta', () => {
  it('seeds the space tier without wiping detail that already arrived', () => {
    const overlaid = overlaySpaceCatalogMeta(
      {
        proj_empty: {
          name: '详情名',
          status: 'active',
          spacePromotedAt: 9,
          goalCount: 2,
        },
      },
      [space({ id: 'proj_empty', name: '目录名', status: 'idle', spacePromotedAt: 5 })],
    );
    expect(overlaid.proj_empty).toMatchObject({
      name: '详情名',
      status: 'active',
      spacePromotedAt: 9,
      goalCount: 2,
    });
  });

  it('hides an archived collaboration space and leaves other groups', () => {
    const groups: WorkspaceGroup[] = [
      {
        key: 'project:proj_archived',
        name: '旧空间',
        paths: [],
        projectId: 'proj_archived',
        isUncategorized: false,
        sessions: [],
        latestActivityAt: 1,
      },
      {
        key: '__chats__',
        name: '快速对话',
        paths: [],
        isUncategorized: true,
        sessions: [],
        latestActivityAt: 1,
      },
    ];
    const visible = hideArchivedCollaborationSpaces(groups, {
      proj_archived: { spacePromotedAt: 4, status: 'archived' },
    });
    expect(visible.map((group) => group.key)).toEqual(['__chats__']);
  });
});
