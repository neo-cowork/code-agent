import { describe, expect, it } from 'vitest';
import {
  findSessionAfterRemoval,
  groupByWorkspace,
  UNCATEGORIZED_WORKSPACE_KEY,
  type WorkspaceGroup,
} from '../../../src/renderer/utils/workspaceGrouping';
import { mergeEmptyCollaborationSpaces } from '../../../src/renderer/utils/emptyCollaborationSpaces';
import { buildSidebarSessionTierSections } from '../../../src/renderer/utils/sidebarSessionTiers';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../../src/shared/constants';
import { UNSORTED_PROJECT_ID, type ProjectWithActivity } from '../../../src/shared/contract/project';

// Owner decision B: a chat started without picking a folder lives in a Neo-made task
// folder (任务_MMDD_… / Task_MMDD_…) but sits in Quick chats under its own title.
const QUICK_CHATS = '快速对话';
const PROJECT_FALLBACK = '项目';

function session(overrides: Partial<SessionWithMeta> & Pick<SessionWithMeta, 'id'>): SessionWithMeta {
  return {
    title: `${overrides.id} chat`,
    createdAt: 1,
    updatedAt: 1,
    modelConfig: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
    messageCount: 2,
    turnCount: 1,
    ...overrides,
  };
}

function group(sessions: SessionWithMeta[]): WorkspaceGroup[] {
  return groupByWorkspace(sessions, QUICK_CHATS, PROJECT_FALLBACK);
}

function groupOf(groups: WorkspaceGroup[], sessionId: string): WorkspaceGroup | undefined {
  return groups.find((candidate) => candidate.sessions.some((item) => item.id === sessionId));
}

describe('workspaceGrouping: chats in a Neo-made task folder', () => {
  it('(a) puts an unsorted chat in 任务_1101_create-role into Quick chats', () => {
    const groups = group([
      session({ id: 'a', projectId: UNSORTED_PROJECT_ID, workingDirectory: '/x/Neo/任务_1101_create-role' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: UNCATEGORIZED_WORKSPACE_KEY, name: QUICK_CHATS, isUncategorized: true });
    expect(groups[0].sessions.map((item) => item.id)).toEqual(['a']);
  });

  it('(b) puts an unsorted chat in Task_1116_init-memory into Quick chats', () => {
    const groups = group([
      session({ id: 'b', projectId: UNSORTED_PROJECT_ID, workingDirectory: '/x/Neo/Task_1116_init-memory' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: UNCATEGORIZED_WORKSPACE_KEY, name: QUICK_CHATS, isUncategorized: true });
    expect(groups[0].sessions.map((item) => item.id)).toEqual(['b']);
  });

  it('(c) puts a chat whose implicit project was minted for its task folder into Quick chats when not pinned', () => {
    const groups = group([
      session({
        id: 'c',
        projectId: 'proj_a',
        workingDirectory: '/x/Neo/任务_1102_weekly-report',
        metadata: { expertThread: { roleId: 'role-1', setAt: 1 } },
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: UNCATEGORIZED_WORKSPACE_KEY, name: QUICK_CHATS, isUncategorized: true });
    expect(groups[0].projectId).toBeUndefined();
    expect(groups.some((candidate) => candidate.key === 'project:proj_a')).toBe(false);
  });

  it('(d) keeps a chat created inside a space (pinned) under that space', () => {
    const groups = group([
      session({
        id: 'd',
        projectId: 'proj_s',
        workingDirectory: '/x/Neo/任务_1103_trip-plan',
        metadata: { projectPinned: true },
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'project:proj_s', projectId: 'proj_s', isUncategorized: false });
    expect(groups[0].sessions.map((item) => item.id)).toEqual(['d']);
    // The space header never borrows the chat's task-folder name for its label or hover paths.
    expect(groups[0].name).toBe(PROJECT_FALLBACK);
    expect(groups[0].paths).toEqual([]);
  });

  it('lists only the user folders of a space that mixes task-folder and user-folder chats', () => {
    const groups = group([
      session({ id: 'trip', projectId: 'proj_s', workingDirectory: '/x/Neo/任务_1103_trip-plan', metadata: { projectPinned: true }, updatedAt: 300 }),
      session({ id: 'photos', projectId: 'proj_s', workingDirectory: '/x/Pictures/kyoto', updatedAt: 200 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'project:proj_s', name: 'kyoto', paths: ['/x/Pictures/kyoto'] });
    expect(groups[0].sessions.map((item) => item.id)).toEqual(['trip', 'photos']);
  });

  it('(e) keeps a user-picked ws- folder as its own folder-named group', () => {
    const groups = group([
      session({ id: 'e', projectId: UNSORTED_PROJECT_ID, workingDirectory: '/x/work/ws-1794806695891' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: '/x/work/ws-1794806695891',
      name: 'ws-1794806695891',
      isUncategorized: false,
    });
  });

  it('(f) leaves a project in a user folder unchanged', () => {
    const groups = group([
      session({ id: 'f', projectId: 'proj_r', workingDirectory: '/x/work/report' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: 'project:proj_r',
      name: 'report',
      path: '/x/work/report',
      projectId: 'proj_r',
      isUncategorized: false,
    });
  });

  it('(g) lands on another Quick-chats session after removing (a)', () => {
    const sessions = [
      session({ id: 'a', projectId: UNSORTED_PROJECT_ID, workingDirectory: '/x/Neo/任务_1101_create-role', updatedAt: 300 }),
      session({ id: 'f', projectId: 'proj_r', workingDirectory: '/x/work/report', updatedAt: 250 }),
      session({ id: 'plain', projectId: UNSORTED_PROJECT_ID, updatedAt: 200 }),
    ];

    expect(groupOf(group(sessions), 'plain')?.key).toBe(UNCATEGORIZED_WORKSPACE_KEY);
    expect(findSessionAfterRemoval(sessions, 'a')?.id).toBe('plain');
  });

  it('reads the task-folder shape from the last segment across separators', () => {
    const groups = group([
      session({ id: 'win', projectId: UNSORTED_PROJECT_ID, workingDirectory: 'C:\\Users\\me\\Neo\\Task_1116_init-memory' }),
      session({ id: 'slash', projectId: UNSORTED_PROJECT_ID, workingDirectory: '/x/Neo/任务_1101_create-role/' }),
      session({ id: 'parent', projectId: UNSORTED_PROJECT_ID, workingDirectory: '/x/Neo/任务_1101_create-role/assets' }),
    ]);

    expect(groupOf(groups, 'win')?.key).toBe(UNCATEGORIZED_WORKSPACE_KEY);
    expect(groupOf(groups, 'slash')?.key).toBe(UNCATEGORIZED_WORKSPACE_KEY);
    expect(groupOf(groups, 'parent')).toMatchObject({ key: '/x/Neo/任务_1101_create-role/assets', name: 'assets' });
  });

  it('only counts the shape directly under a Neo work root, so a user folder named like it keeps its group', () => {
    const groups = group([
      session({ id: 'slot', projectId: UNSORTED_PROJECT_ID, workingDirectory: '/x/Neo-dev/Task_1116_init-memory' }),
      session({ id: 'custom', projectId: UNSORTED_PROJECT_ID, workingDirectory: '/x/neo-data-work/任务_1101_create-role' }),
      session({ id: 'picked', projectId: 'proj_u', workingDirectory: '/x/Documents/Task_2025_budget' }),
    ]);

    expect(groupOf(groups, 'slot')?.key).toBe(UNCATEGORIZED_WORKSPACE_KEY);
    expect(groupOf(groups, 'custom')?.key).toBe(UNCATEGORIZED_WORKSPACE_KEY);
    expect(groupOf(groups, 'picked')).toMatchObject({
      key: 'project:proj_u',
      name: 'Task_2025_budget',
      paths: ['/x/Documents/Task_2025_budget'],
    });
  });
});

// A task-folder project the user promoted to a space (space page promote, or createSpace on that
// folder) is still a space: once the space catalog says so, its chats leave Quick chats again.
describe('sidebar tiers: a space whose own folder is a Neo-made task folder', () => {
  const taskFolder = '/x/Neo/任务_1104_family-budget';

  function space(overrides: Partial<ProjectWithActivity> & Pick<ProjectWithActivity, 'id'>): ProjectWithActivity {
    return {
      name: 'Family budget',
      status: 'idle',
      createdAt: 1,
      updatedAt: 10,
      activeTopicCount: 0,
      lastActivityAt: null,
      visibleSessionCount: 0,
      spacePromotedAt: 5,
      workspacePath: taskFolder,
      ...overrides,
    };
  }

  function tiersOf(sections: ReturnType<typeof buildSidebarSessionTierSections>) {
    return Object.fromEntries(sections.map((section) => [
      section.tier,
      section.groups.map((item) => ({ key: item.key, sessions: item.sessions.map((s) => s.id) })),
    ]));
  }

  const promotedChats = [
    session({ id: 'budget', projectId: 'proj_t', workingDirectory: taskFolder, updatedAt: 300 }),
    session({ id: 'plain', projectId: UNSORTED_PROJECT_ID, updatedAt: 200 }),
  ];

  it('keeps the chats in Quick chats until the space catalog arrives, then returns them to the space', () => {
    const groups = group(promotedChats);

    expect(tiersOf(buildSidebarSessionTierSections(groups, {}))).toEqual({
      quick: [{ key: UNCATEGORIZED_WORKSPACE_KEY, sessions: ['budget', 'plain'] }],
    });
    expect(tiersOf(buildSidebarSessionTierSections(groups, { proj_t: { name: 'Family budget', spacePromotedAt: 5 } }))).toEqual({
      space: [{ key: 'project:proj_t', sessions: ['budget'] }],
      quick: [{ key: UNCATEGORIZED_WORKSPACE_KEY, sessions: ['plain'] }],
    });
  });

  it('merges returned chats into the group the space already has for its pinned chats', () => {
    const groups = group([
      ...promotedChats,
      session({ id: 'pinned', projectId: 'proj_t', workingDirectory: '/x/Neo/任务_1105_receipts', metadata: { projectPinned: true }, updatedAt: 100 }),
    ]);

    const sections = buildSidebarSessionTierSections(groups, { proj_t: { name: 'Family budget', spacePromotedAt: 5 } });
    expect(tiersOf(sections)).toEqual({
      space: [{ key: 'project:proj_t', sessions: ['budget', 'pinned'] }],
      quick: [{ key: UNCATEGORIZED_WORKSPACE_KEY, sessions: ['plain'] }],
    });
    expect(sections[0].groups[0]).toMatchObject({ projectId: 'proj_t', latestActivityAt: 300, paths: [] });
  });

  it('keys an empty space on a task folder as the space, not as Quick chats', () => {
    const groups = mergeEmptyCollaborationSpaces(group([session({ id: 'plain', projectId: UNSORTED_PROJECT_ID })]), [space({ id: 'proj_e' })]);

    expect(tiersOf(buildSidebarSessionTierSections(groups, { proj_e: { name: 'Family budget', spacePromotedAt: 5 } }))).toEqual({
      space: [{ key: 'project:proj_e', sessions: [] }],
      quick: [{ key: UNCATEGORIZED_WORKSPACE_KEY, sessions: ['plain'] }],
    });
  });

  it('does not bring back the chats of an archived space', () => {
    const sections = buildSidebarSessionTierSections(group(promotedChats), {
      proj_t: { name: 'Family budget', spacePromotedAt: 5, status: 'archived' },
    });

    expect(tiersOf(sections)).toEqual({ quick: [{ key: UNCATEGORIZED_WORKSPACE_KEY, sessions: ['plain'] }] });
  });
});
