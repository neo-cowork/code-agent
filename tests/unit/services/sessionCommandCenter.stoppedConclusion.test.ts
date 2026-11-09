import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { TaskManager, TaskManagerEvent } from '../../../src/host/task/TaskManager';
import type { AgentEvent } from '../../../src/shared/contract';
import { SessionCommandCenter } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { resetBackgroundTaskLedgerForTest } from '../../../src/host/task/backgroundTaskLedger';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

const SCOPE = createWorkspaceScope('project-stop', [{
  sourceId: 'source-stop', path: '/tmp/stop-project', role: 'primary', access: 'read_write',
}]);

class FakeTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockResolvedValue(undefined);
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  private readonly observers = new Set<(s: string, e: AgentEvent, t?: string) => void>();
  observeAgentEvents(o: (s: string, e: AgentEvent, t?: string) => void): () => void {
    this.observers.add(o);
    return () => this.observers.delete(o);
  }
  emitAgent(s: string, e: AgentEvent, t?: string): void { this.observers.forEach((o) => o(s, e, t)); }
  emitTask(e: TaskManagerEvent): void { this.emit(e.type, e); }
}

async function setup() {
  const manager = new FakeTaskManager();
  const projected: Array<{ status: string; resultText?: string; summary?: string }> = [];
  const center = new SessionCommandCenter(manager as unknown as TaskManager, {
    projectTerminalResult: vi.fn(async (task, status) => {
      projected.push({ status, resultText: task.resultText, summary: task.summary });
    }),
    wakeForegroundBrain: vi.fn(),
  });
  const spawned = await center.spawn({
    sessionId: 'session-stop', title: '百度热搜', shortName: '百度热搜', laneKey: 'baidu',
    submissionKey: 'baidu-1', prompt: '打开百度首页并总结', workspaceScope: SCOPE,
  });
  if (spawned.outcome === 'requires_choice') throw new Error('unexpected');
  const visit = (url: string) => manager.emitAgent('session-stop', {
    type: 'tool_call_start', data: { id: `c-${url}`, name: 'Browser', arguments: { action: 'navigate', url } },
  } as AgentEvent, spawned.task.id);
  return { manager, projected, taskId: spawned.task.id, visit };
}

describe('session task (delegate_task) stop conclusion', () => {
  beforeEach(() => {
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
  });

  it('pins the max-steps marker to the real main-loop wording', () => {
    const source = readFileSync('src/host/agent/runtime/maxStepsFallback.ts', 'utf8');
    expect(source).toContain('已达最大执行轮次');
  });

  it('does not report a step-cap run as completed and names the last page', async () => {
    const { manager, projected, taskId, visit } = await setup();
    visit('https://www.baidu.com');
    manager.emitTask({
      type: 'task_completed', sessionId: 'session-stop',
      data: { taskId, conclusion: '⚠️ 已达最大执行轮次（3 轮），任务未全部完成，执行已停止。\n\n**为什么停：** 达到单次运行的最大执行轮次上限（3 轮）。可以发新指令让我从当前进度继续，或把任务拆小后重试。' },
    });
    await vi.waitFor(() => expect(projected).toHaveLength(1));
    expect(projected[0].status).toBe('failed');
    expect(projected[0].resultText).toContain('已达最大执行轮次（3 轮）');
    expect(projected[0].resultText).toContain('最后停留在页面https://www.baidu.com');
  });

  it('turns an empty conclusion into a plain failed result instead of "任务已完成"', async () => {
    const { manager, projected, taskId, visit } = await setup();
    visit('https://www.baidu.com/s?wd=a');
    manager.emitTask({ type: 'task_completed', sessionId: 'session-stop', data: { taskId } });
    await vi.waitFor(() => expect(projected).toHaveLength(1));
    expect(projected[0].status).toBe('failed');
    expect(projected[0].resultText).toContain('最后停留在页面https://www.baidu.com/s?wd=a，但没有留下最终结果');
    expect(projected[0].resultText).toContain('继续');
    expect(projected[0].resultText).not.toContain('任务已完成');
  });

  it('wraps a raw English runtime error in a plain Chinese reason', async () => {
    const { manager, projected, taskId } = await setup();
    manager.emitTask({ type: 'task_error', sessionId: 'session-stop', data: { taskId, error: 'inference provider returned 429' } });
    await vi.waitFor(() => expect(projected).toHaveLength(1));
    expect(projected[0].status).toBe('failed');
    expect(projected[0].resultText).toContain('模型服务暂时出错或请求太频繁');
    expect(projected[0].resultText).not.toMatch(/429|inference/);
  });

  it('leaves a normal conclusion untouched', async () => {
    const { manager, projected, taskId } = await setup();
    manager.emitTask({ type: 'task_completed', sessionId: 'session-stop', data: { taskId, conclusion: '三条热搜摘要已写好。' } });
    await vi.waitFor(() => expect(projected).toHaveLength(1));
    expect(projected[0]).toMatchObject({ status: 'completed', resultText: '三条热搜摘要已写好。' });
  });
});
