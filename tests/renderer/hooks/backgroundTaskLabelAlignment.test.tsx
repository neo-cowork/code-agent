// @vitest-environment jsdom
// 同一会话里多个英文标题的后台任务：任务栏 / 成员列表 / 回放摘要必须给同一个任务同一个「助手 N」，
// 且序号按会话账本全集算，不随各视图自己筛过的子集或数组下标漂移。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@shared/contract/backgroundTask';
import { TASK_PANEL_DISMISSED_KEY } from '@shared/contract/backgroundTask';
import { languages } from '../../../src/renderer/i18n';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh, language: 'zh' }) }));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: null, refresh: async () => {} }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn().mockResolvedValue([]), invokeDomain: vi.fn().mockResolvedValue(null) },
}));

import { useSessionAgentRows } from '../../../src/renderer/hooks/useSessionAgentRows';
import { buildLedgerTaskRecords } from '../../../src/renderer/hooks/useRunWorkbenchModel';
import { deriveTaskRailView } from '../../../src/renderer/utils/taskRailPresentation';
import { buildSessionReplayEvidenceMap } from '../../../src/renderer/utils/sessionReplayEvidence';
import { SessionReplaySummaryDialog } from '../../../src/renderer/components/features/sidebar/SessionReplaySummaryDialog';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';

const SESSION = 'session-1';
const mk = (id: string, title: string, createdAt: number, extra: Partial<Task> = {}): Task => ({
  id, sessionId: SESSION, source: 'delegate_task', title, status: 'running',
  createdAt, updatedAt: createdAt, events: [], outputRefs: [], ...extra,
} as Task);

// 账本按「新→旧」排列；X 已被用户从面板移除（dismissed），所以成员列表里只剩 Y、Z。
const X = mk('task-x', 'Compare supplier pricing now', 1000, { metadata: { [TASK_PANEL_DISMISSED_KEY]: true } });
const Y = mk('task-y', 'Summarize meeting notes today', 1001);
const Z = mk('task-z', 'Draft the weekly report now', 1002);
const LEDGER = [Z, Y, X];

describe('background task 「助手 N」 is the same task-to-name mapping in every view', () => {
  beforeEach(() => {
    useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
  });
  afterEach(() => {
    cleanup();
    useBackgroundTaskStore.getState().setTasks([]);
  });

  it('task rail and member list agree even when the member list hides a sibling', () => {
    useBackgroundTaskStore.getState().setTasks(LEDGER);
    const rows = renderHook(() => useSessionAgentRows(SESSION)).result.current.rows;
    const rowNames = Object.fromEntries(rows.map((row) => [row.key, row.name]));

    const rail = Object.fromEntries(buildLedgerTaskRecords(LEDGER, SESSION, languages.zh)
      .map((record) => [record.id.replace('background:', ''), deriveTaskRailView(record, null, languages.zh).title]));

    expect(rail).toEqual({ 'task-z': '助手 3', 'task-y': '助手 2', 'task-x': '助手 1' });
    expect(rowNames['task-y']).toBe(rail['task-y']);
    expect(rowNames['task-z']).toBe(rail['task-z']);
  });

  it('replay summary shows distinct numbered cards (same minute, same status) matching the rail', () => {
    const html = renderToStaticMarkup(
      <SessionReplaySummaryDialog
        sessionTitle="s"
        onClose={vi.fn()}
        backgroundTasks={LEDGER}
        replay={{
          sessionId: SESSION, traceSource: 'session_replay', dataSource: 'telemetry', turns: [],
          traceIdentity: { traceId: 't', traceSource: 'session_replay', source: 'session_replay', sessionId: SESSION, replayKey: SESSION },
          summary: { totalTurns: 0, toolDistribution: { Read: 0, Edit: 0, Write: 0, Bash: 0, Search: 0, Web: 0, Agent: 0, Skill: 0, Other: 0 }, thinkingRatio: 0, selfRepairChains: 0, totalDurationMs: 0 },
        } as never}
      />,
    );
    for (const label of ['助手 1', '助手 2', '助手 3']) expect(html).toContain(`>${label}</div>`);
    expect(html).not.toContain('Summarize meeting notes');
  });

  it('replay evidence labels use the same numbering', () => {
    const withRef = (task: Task): Task => ({
      ...task,
      outputRefs: [{ id: `${task.id}-r`, taskId: task.id, type: 'trace', label: 'trace.json', path: '/tmp/t.json', size: 0, createdAt: 5 }],
    });
    const map = buildSessionReplayEvidenceMap({}, LEDGER.map(withRef), languages.zh);
    const byId = Object.fromEntries((map.get(SESSION) ?? []).map((item) => [item.id, item.sourceLabel]));
    expect(byId['background:task-y:task-y-r']).toBe('助手 2');
    expect(byId['background:task-z:task-z-r']).toBe('助手 3');
  });
});
