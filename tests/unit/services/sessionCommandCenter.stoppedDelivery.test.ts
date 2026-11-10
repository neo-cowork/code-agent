import Database from 'better-sqlite3';
vi.unmock('better-sqlite3');
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message } from '../../../src/shared/contract';
import type { ConfigService } from '../../../src/host/services/core/configService';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../src/shared/constants';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

const h = vi.hoisted(() => ({
  manager: undefined as unknown,
  db: undefined as unknown as Database.Database,
  repository: undefined as unknown as SessionRepository,
  variant: 'step_cap' as 'step_cap' | 'error' | 'no_conclusion' | 'completed',
  events: [] as AgentEvent[],
  pageOutput: '',
}));
const storage = {
  addMessageToSession: async (sessionId: string, message: Message) => {
    h.repository.addMessage(sessionId, message);
  },
  updateMessage: async (id: string, patch: Partial<Message>) => {
    h.repository.updateMessage(id, patch);
  },
};
vi.mock('../../../src/host/services/infra/sessionManager', () => ({ getSessionManager: () => storage }));
vi.mock('../../../src/host/services', () => ({ getSessionManager: () => storage, notificationService: {} }));
vi.mock('../../../src/host/task/TaskManager', async (original) => ({
  ...await original<typeof import('../../../src/host/task/TaskManager')>(),
  getTaskManager: () => h.manager,
}));
vi.mock('../../../src/host/task/backgroundTaskSessionContext', () => ({ getBackgroundTaskSessionContext: async () => null }));
// Only the model/runtime boundary is replaced. TaskManager owns terminal events and persistence.
vi.mock('../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    constructor(private readonly options: { onEvent: (event: AgentEvent) => Promise<void> }) {}
    setSessionId() {}
    setWorkspaceScopeAuthority() {}
    getMessages() { return h.variant === 'no_conclusion' ? [] : [{ role: 'assistant', content: '已查看首页。' }]; }
    async sendMessage() {
      await this.options.onEvent({ type: 'tool_call_start', data: {
        id: 'browser-1', name: 'Browser', arguments: { action: 'navigate', url: 'https://baike.baidu.com/item/%E9%B9%88%E9%B9%95' },
      } } as AgentEvent);
      await this.options.onEvent({ type: 'tool_call_end', data: {
        toolCallId: 'browser-1', success: true, output: h.pageOutput,
      } });
      if (h.variant === 'error') throw new Error('inference provider returned 429');
      if (h.variant === 'step_cap') await this.options.onEvent({ type: 'error', data: {
        code: RUN_ERROR_CODE_MAX_ITERATIONS, message: 'cap reached',
      } } as AgentEvent);
    }
  },
}));

import { BackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { TaskManager } from '../../../src/host/task/TaskManager';
import { SessionCommandCenter } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { resetBackgroundTaskLedgerForTest } from '../../../src/host/task/backgroundTaskLedger';

function rows(): Message[] {
  return h.repository.getMessages('session-stop');
}
let center: SessionCommandCenter;
let manager: TaskManager;
beforeEach(() => {
  h.db = new Database(':memory:');
  applyTestSessionSchema(h.db);
  h.repository = new SessionRepository(h.db);
  h.repository.createSession({
    id: 'session-stop', title: '百科摘要',
    modelConfig: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
    createdAt: 1, updatedAt: 1,
  });
  h.events = [];
  h.pageOutput = 'URL: https://baike.baidu.com/item/%E9%B9%88%E9%B9%95\nTitle: 鹈鹕_百度百科';
  resetSessionTaskConcurrencyPoolForTest();
  resetBackgroundTaskLedgerForTest();
  manager = new TaskManager();
  h.manager = manager;
  manager.initialize({ configService: {} as ConfigService, onAgentEvent: (_sessionId, event) => { h.events.push(event); } });
  center = new SessionCommandCenter(manager, { wakeForegroundBrain: vi.fn() });
});
afterEach(() => { center?.dispose(); h.db?.close(); });

async function stop(variant: typeof h.variant) {
  h.variant = variant;
  manager.emitAgentEventForSession('session-stop', { type: 'message', data: {
    id: 'foreground-reply', role: 'assistant', content: '正在整理你的周报，已保留第一部分。', timestamp: 1,
  } });
  await vi.waitFor(() => expect(rows()).toHaveLength(1));
  const result = await center.spawn({
    sessionId: 'session-stop', title: '百科摘要', shortName: '百科摘要', laneKey: 'baike', submissionKey: 'baike-1',
    prompt: '在后台用浏览器打开百度百科首页，再点开三个词条，给我写个简短摘要',
    workspaceScope: createWorkspaceScope('project-stop', [{ sourceId: 'root', path: '/tmp/stop-project', role: 'primary', access: 'read_write' }]),
    options: { mode: 'normal', maxIterations: 3 },
  });
  if (result.outcome === 'requires_choice') throw new Error('unexpected admission result');
  await vi.waitFor(() => expect(rows().some((m) => m.metadata?.backgroundTaskResult)).toBe(true));
  // Replay the same terminal event: must not create a second visible note.
  manager.emit('task_error', { type: 'task_error', sessionId: 'session-stop', data: { taskId: result.task.id, error: 'duplicate' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return rows();
}

describe('background stop delivery through SessionCommandCenter + TaskManager persistence', () => {
  it.each(['step_cap', 'error', 'no_conclusion'] as const)('%s persists one info note without overwriting an in-flight foreground reply', async (kind) => {
    const messages = await stop(kind);
    expect(messages.find((m) => m.id === 'foreground-reply')?.content).toBe('正在整理你的周报，已保留第一部分。');
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    const notes = messages.filter((m) => m.metadata?.backgroundTaskStopped);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ role: 'system', metadata: { backgroundTaskStopped: { kind } } });
    expect(notes[0].content).toContain('百科摘要');
    expect(notes[0].content).toContain('鹈鹕_百度百科');
    expect(notes[0].content).toContain('继续');
    expect(notes[0].content).not.toMatch(/429|inference|%E9/);
    if (kind === 'step_cap') expect(notes[0].content).toContain('第 3 步（上限 3 步）');
    if (kind === 'error') expect(notes[0].content).toContain('模型服务暂时出错或请求太频繁');
    const nodes = projectTurns(messages, 'session-stop', false).turns.flatMap((t) => t.nodes);
    expect(nodes.filter((n) => n.subtype === 'error')).toHaveLength(0);
    expect(nodes.find((n) => n.id === notes[0].id)).toMatchObject({ type: 'system', content: notes[0].content });
    expect(h.events.filter((e) => e.type === 'message' && e.data.metadata?.backgroundTaskStopped)).toHaveLength(1);
    console.log(`${kind}: ${JSON.stringify(notes[0])}; foreground unchanged; assistant rows=1; error nodes=0`);
  });

  it.each([
    ['https://baike.baidu.com/item/%E9%B9%88%E9%B9%95', 'https://baike.baidu.com/item/鹈鹕'],
    ['https://example.com/%E0%A4%A', 'https://example.com/%E0%A4%A'],
  ])('uses a decodeURI-safe URL when the last page has no title: %s', async (url, expected) => {
    h.pageOutput = `URL: ${url}`;
    const notes = (await stop('step_cap')).filter((m) => m.metadata?.backgroundTaskStopped);
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain(`最后停留在页面${expected}`);
  });

  it('uses the latest DOM snapshot page title after navigation', async () => {
    h.pageOutput = 'DOM snapshot snapshot-example\nurl: https://baike.baidu.com/item/人工智能\ntitle: 人工智能_百度百科';
    const notes = (await stop('step_cap')).filter((m) => m.metadata?.backgroundTaskStopped);
    expect(notes[0].content).toContain('最后停留在页面「人工智能_百度百科」');
  });

  it.each(['returned_error', 'thrown_error', 'empty_success'] as const)('registry sibling %s uses the same system delivery channel', async (variant) => {
    const registry = new BackgroundSubagentRegistry();
    const id = registry.spawn(async () => {
      if (variant === 'thrown_error') throw new Error('模型错误：inference provider returned 429');
      return { success: variant === 'empty_success', output: '', error: variant === 'empty_success' ? undefined : 'inference provider returned 429', toolsUsed: [], iterations: 2 };
    }, { sessionId: 'session-stop', title: '百科摘要', suppressIdleWake: true });
    await registry.await(id);
    const notes = rows().filter((m) => m.metadata?.backgroundTaskStopped);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ role: 'system', metadata: { backgroundTaskStopped: {
      taskId: id, kind: variant === 'empty_success' ? 'no_conclusion' : 'error',
    } } });
    expect(notes[0].content).toContain('继续');
    expect(notes[0].content).not.toMatch(/429|inference|provider/);
    expect(rows().filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('does not announce a normal completion as stopped', async () => {
    const messages = await stop('completed');
    expect(messages.filter((m) => m.metadata?.backgroundTaskStopped)).toHaveLength(0);
  });
});
