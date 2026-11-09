import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskManager } from '../../../src/host/task/TaskManager';
import type { ToolContext, CanUseToolFn } from '../../../src/host/protocol/tools';
import {
  executeTaskStatus,
} from '../../../src/host/tools/modules/commandCenter/sessionCommandCenter';
import {
  getSessionCommandCenter,
  resetSessionCommandCenterForTest,
} from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { getBackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';

const taskManagerHolder = vi.hoisted(() => ({ manager: undefined as unknown }));
vi.mock('../../../src/host/task/TaskManager', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTaskManager: () => taskManagerHolder.manager,
}));

class FakeTaskManager extends EventEmitter {
  observeAgentEvents(): () => void {
    return () => undefined;
  }
}

const allow: CanUseToolFn = async () => ({ allow: true });

function context(sessionId: string): ToolContext {
  return {
    sessionId,
    abortSignal: new AbortController().signal,
  } as unknown as ToolContext;
}

function result(output: string): SubagentResult {
  return { success: true, output, toolsUsed: [], iterations: 1 };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe('executeTaskStatus detached subagents', () => {
  beforeEach(() => {
    taskManagerHolder.manager = new FakeTaskManager() as unknown as TaskManager;
    resetSessionCommandCenterForTest();
    resetSpawnGuard();
  });

  afterEach(() => {
    getSessionCommandCenter();
    resetSessionCommandCenterForTest();
    resetSpawnGuard();
    taskManagerHolder.manager = undefined;
  });

  it('reports a running registry subagent through the production entry', async () => {
    const sessionId = 'detached-status-registry-running';
    const pending = deferred<SubagentResult>();
    const agentId = getBackgroundSubagentRegistry().spawn(() => pending.promise, {
      sessionId,
      title: 'Folder A',
    });

    const status = await executeTaskStatus({}, context(sessionId), allow);

    expect(status).toMatchObject({ ok: true });
    expect(status.output).toContain(`1. Folder A [running] id=${agentId}`);
    expect(status.output).not.toContain('当前会话还没有后台任务');
    pending.resolve(result('folder A summary'));
    await getBackgroundSubagentRegistry().await(agentId);
  });

  it('reports the registry result after a subagent finishes between two calls', async () => {
    const sessionId = 'detached-status-registry-finished';
    const pending = deferred<SubagentResult>();
    const agentId = getBackgroundSubagentRegistry().spawn(() => pending.promise, {
      sessionId,
      title: 'Folder B',
    });

    const before = await executeTaskStatus({}, context(sessionId), allow);
    pending.resolve(result('folder B summary'));
    await getBackgroundSubagentRegistry().await(agentId);
    const after = await executeTaskStatus({}, context(sessionId), allow);

    expect(before.output).toContain('[running]');
    expect(after.output).toContain(`1. Folder B [completed] id=${agentId}：folder B summary`);
  });

  it('reports a SpawnGuard subagent while running and after completion', async () => {
    const sessionId = 'detached-status-spawn-guard';
    const pending = deferred<SubagentResult>();
    const agentId = 'agent_explore_detached-status';
    getSpawnGuard().register(
      agentId,
      'explore',
      'Folder C',
      pending.promise,
      new AbortController(),
      { treeId: sessionId, completion: { title: 'Folder C' } },
    );

    const before = await executeTaskStatus({}, context(sessionId), allow);
    pending.resolve(result('folder C summary'));
    await pending.promise;
    const after = await executeTaskStatus({}, context(sessionId), allow);

    expect(before.output).toContain(`1. Folder C [running] id=${agentId}`);
    expect(after.output).toContain(`1. Folder C [completed] id=${agentId}：folder C summary`);
  });

  it('keeps the existing empty text when no task registry has this session', async () => {
    const status = await executeTaskStatus({}, context('detached-status-empty'), allow);

    expect(status).toEqual({ ok: true, output: '当前会话还没有后台任务。' });
  });

  it('lists one run_in_background helper once, named after its agent', async () => {
    const sessionId = 'detached-status-linked';
    const pending = deferred<SubagentResult>();
    const backgroundId = getBackgroundSubagentRegistry().spawn(() => pending.promise, {
      sessionId,
      title: 'Read all five notes in folder-b and summarize them',
      role: 'explore',
    });
    getSpawnGuard().register(
      'agent_explore_linked',
      'explore',
      'Read all five notes in folder-b and summarize them',
      pending.promise,
      new AbortController(),
      { treeId: sessionId, completion: { title: 'Explorer' }, backgroundAgentId: backgroundId },
    );

    const status = await executeTaskStatus({}, context(sessionId), allow);

    expect(status.output).toContain(`1. Explorer [running] id=${backgroundId}`);
    expect(status.output).not.toContain('2. ');
    expect(status.output).not.toContain('agent_explore_linked');
    pending.resolve(result('folder B summary'));
    await getBackgroundSubagentRegistry().await(backgroundId);
  });

  it('names a helper by the name the model gave, before SpawnGuard has registered it', async () => {
    const sessionId = 'detached-status-named';
    const pending = deferred<SubagentResult>();
    const agentId = getBackgroundSubagentRegistry().spawn(() => pending.promise, { sessionId, title: '总结B' });

    const status = await executeTaskStatus({}, context(sessionId), allow);

    expect(status.output).toContain(`1. 总结B [running] id=${agentId}`);
    pending.resolve(result('done'));
    await getBackgroundSubagentRegistry().await(agentId);
  });

  it('drops the "Agent [name] completed task:" header from a finished helper summary', async () => {
    const sessionId = 'detached-status-header';
    const agentId = getBackgroundSubagentRegistry().spawn(
      async () => result('Agent [总结B] completed task:\n\nTask: 读取 folder-b\n\nResult:\n五条客户回访集中在交付时间。\n\nStats:\n- Iterations: 3'),
      { sessionId, title: '总结B' },
    );
    await getBackgroundSubagentRegistry().await(agentId);

    const status = await executeTaskStatus({}, context(sessionId), allow);

    expect(status.output).toContain('[completed]');
    expect(status.output).toContain('五条客户回访集中在交付时间。');
    expect(status.output).not.toContain('completed task');
    expect(status.output).not.toContain('Stats');
  });
});
