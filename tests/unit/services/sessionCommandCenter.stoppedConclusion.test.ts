import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskManager, TaskManagerEvent } from '../../../src/host/task/TaskManager';
import type { AgentEvent } from '../../../src/shared/contract';
import { SessionCommandCenter } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { resetBackgroundTaskLedgerForTest } from '../../../src/host/task/backgroundTaskLedger';
const sink = vi.hoisted(() => ({
  added: [] as Array<{ role: string; content: string }>,
  emitted: [] as Array<{ type: string; data: { role: string; content: string } }>,
}));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: vi.fn(async (_sid: string, m: { role: string; content: string }) => { sink.added.push(m); }),
  }),
}));
vi.mock('../../../src/host/task/TaskManager', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTaskManager: () => ({
    emitAgentEventForSession: (_sid: string, e: { type: string; data: { role: string; content: string } }) => { sink.emitted.push(e); },
  }),
}));
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

  it('does not report a step-cap run as completed: step M of M, last page, next step', async () => {
    const { manager, projected, taskId, visit } = await setup();
    visit('https://www.baidu.com');
    manager.emitAgent('session-stop', {
      type: 'error', data: { message: 'Max iterations reached', code: 'MAX_ITERATIONS_REACHED' },
    } as AgentEvent, taskId);
    manager.emitTask({
      type: 'task_completed', sessionId: 'session-stop',
      data: { taskId, conclusion: '已达本任务最大步数上限，工具已禁用，以下为文本总结。尚未打开词条。' },
    });
    await vi.waitFor(() => expect(projected).toHaveLength(1));
    expect(projected[0].status).toBe('failed');
    expect(projected[0].resultText).toMatch(/第 \d+ 步（上限 \d+ 步）就用完了步数/);
    expect(projected[0].resultText).toContain('最后停留在页面https://www.baidu.com');
    expect(projected[0].resultText).toContain('继续');
    expect(projected[0].resultText).toContain('尚未打开词条');
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

  it('writes the stop sentence into the conversation as an assistant message (default projection)', async () => {
    sink.added.length = 0; sink.emitted.length = 0;
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, { wakeForegroundBrain: vi.fn() });
    const spawned = await center.spawn({
      sessionId: 'session-stop', title: '百度热搜', shortName: '百度热搜', laneKey: 'baidu',
      submissionKey: 'baidu-2', prompt: '打开百度首页并总结', workspaceScope: SCOPE,
    });
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected');
    manager.emitAgent('session-stop', { type: 'tool_call_start', data: { id: 'c1', name: 'Browser', arguments: { url: 'https://baike.baidu.com' } } } as AgentEvent, spawned.task.id);
    manager.emitAgent('session-stop', { type: 'error', data: { message: 'Max iterations reached', code: 'MAX_ITERATIONS_REACHED' } } as AgentEvent, spawned.task.id);
    manager.emitTask({ type: 'task_completed', sessionId: 'session-stop', data: { taskId: spawned.task.id, conclusion: '工具已禁用。' } });
    await vi.waitFor(() => expect(sink.added.filter((m) => m.role === 'assistant')).toHaveLength(1));
    const notice = sink.added.find((m) => m.role === 'assistant')!;
    expect(notice.content).toMatch(/^「百度热搜」后台任务做到第 \d+ 步（上限 \d+ 步）就用完了步数，最后停留在页面https:\/\/baike\.baidu\.com，/);
    expect(notice.content).toContain('继续');
    expect(sink.emitted).toHaveLength(1);
    expect(sink.emitted[0].data.content).toBe(notice.content);
    // 正常结束不额外写助手消息
    expect(sink.added.filter((m) => m.role === 'system')).toHaveLength(1);
  });
});
