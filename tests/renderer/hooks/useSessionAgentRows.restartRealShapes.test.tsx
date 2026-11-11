// @vitest-environment jsdom
// ============================================================================
// 重启前后底栏数的是同一批真代理/任务（N-FIX-BGPANEL-STOP-TERMINAL-FU1-FU1-FU1）
// 夹具 = 真跑（web 构建 + neo-realrun kill9/restart，默认权限档，coder 子代理 Bash
// run_in_background）里抓到的 getTree 返回与后台任务账本行，不是手搓对象。
// 场景：coder 已完成 + 一条后台 shell 任务被用户停掉；重启前后行集合与「已取消」数一致，
// 不多出幽灵行。真 backgroundTaskStore + 真 appStore + 真 useSessionAgentRows。
// ============================================================================
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTreeSnapshot } from '@shared/contract/agentTree';
import type { Task } from '@shared/contract/backgroundTask';
import fixture from './fixtures/restartWalkthroughRealShapes.json';

const runtime = vi.hoisted(() => ({ snapshot: null as unknown }));

vi.mock('../../../src/renderer/components/features/expert/SessionMemberBar', () => ({
  useSessionMembers: () => [],
}));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: runtime.snapshot, refresh: async () => {} }),
}));

import { useSessionAgentRows } from '../../../src/renderer/hooks/useSessionAgentRows';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';

const shellTask = fixture.shellTaskAfterStop as unknown as Task;

function rowsFor(snapshot: unknown) {
  runtime.snapshot = snapshot as AgentTreeSnapshot;
  return renderHook(() => useSessionAgentRows(shellTask.sessionId ?? null)).result.current.rows;
}

describe('useSessionAgentRows with real restart snapshots', () => {
  beforeEach(() => {
    useBackgroundTaskStore.getState().setTasks([shellTask]);
  });
  afterEach(() => {
    cleanup();
    runtime.snapshot = null;
    useBackgroundTaskStore.getState().setTasks([]);
  });

  it('shows the same rows and the same cancelled count before and after restart', () => {
    const before = rowsFor(fixture.getTreeBeforeRestart);
    const after = rowsFor(fixture.getTreeAfterRestart);

    const summarize = (rows: ReturnType<typeof rowsFor>) => rows.map((row) => `${row.kind}:${row.status}`).sort();
    expect(summarize(before)).toEqual(['agent:done', 'task:cancelled']);
    expect(summarize(after)).toEqual(summarize(before));
    expect(after.filter((row) => row.status === 'cancelled')).toHaveLength(1);
  });

  it('keeps captured fixtures free of absolute home paths and sandbox temp paths', () => {
    const raw = readFileSync(resolve(process.cwd(), 'tests/renderer/hooks/fixtures/restartWalkthroughRealShapes.json'), 'utf8');
    expect(raw).not.toMatch(/\/Users\/|\/var\/folders\/|\/home\/[a-z]+\/work\//);
  });
});
