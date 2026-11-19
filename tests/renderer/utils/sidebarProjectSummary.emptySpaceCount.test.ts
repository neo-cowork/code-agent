import { describe, expect, it } from 'vitest';
import { groupByWorkspace, type WorkspaceGroup } from '../../../src/renderer/utils/workspaceGrouping';
import { buildSidebarProjectSummary } from '../../../src/renderer/utils/sidebarProjectSummary';

const summarize = (group: WorkspaceGroup, sessionCount: number) => buildSidebarProjectSummary({
  group,
  backgroundSessionMap: new Map(),
  sessionRuntimes: new Map(),
  sessionStates: {},
  projectMeta: { projectId: 'p1', sessionCount } as never,
} as never);

describe('sidebar project summary session count', () => {
  const emptyGroup = groupByWorkspace([], '快速对话', '项目', [{ id: 'p1', name: 'P', workspacePath: null }])[0];

  it('(a) an empty space group shows 0 even when the wide project meta counts archived/other-owner sessions', () => {
    const summary = summarize(emptyGroup, 4);
    expect(summary.sessionCount).toBe(0);
  });

  it('(c) a group with a visible session still shows the meta count', () => {
    const group: WorkspaceGroup = { ...emptyGroup, sessions: [{ id: 's1', updatedAt: 1 } as WorkspaceGroup['sessions'][number]] };
    expect(summarize(group, 1).sessionCount).toBe(1);
  });
});
