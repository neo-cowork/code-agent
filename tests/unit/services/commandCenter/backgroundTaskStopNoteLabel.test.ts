import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// N-FIX-BGTASK-CARD-DONE-WITH-FAILED-CONTENT-REST5：
// 卡片下停止行「」里的名字从 2-4 字符引用键（「抓gui」/「抓取do」这类半截词）换成完整任务标题；
// 超长标题在词边界截断（绝不在英文单词内部下刀），中文界面遇到纯英文标题退回短键。
// 全部走产线入口 projectTerminalResult（两个调用点：stopped 与 cancelled）和
// recordBackgroundTaskStopNote（backgroundSubagentRegistry 与投影共用的落库函数），
// 只替换写路径（sessionManager 捕获）、locale（configService）与 TaskManager 收口外的重壳。

const harness = vi.hoisted(() => ({
  locale: 'zh' as 'zh' | 'en',
  messages: [] as Array<{ sessionId: string; id: string; role: string; content: string; metadata: unknown }>,
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: async (sessionId: string, message: { id: string; role: string; content: string; metadata?: unknown }) => {
      harness.messages.push({ sessionId, id: message.id, role: message.role, content: message.content, metadata: message.metadata });
    },
  }),
}));

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: harness.locale } }) }),
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => ({ id: 'u1' }), addAuthChangeCallback: () => () => undefined }),
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  getSupabase: () => null,
  isSupabaseInitialized: () => false,
}));

vi.mock('../../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {},
}));

vi.mock('../../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
  broadcastToRenderer: vi.fn(),
  hasInteractiveUi: () => false,
}));

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: true, updateSession: vi.fn() }),
}));

vi.mock('../../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => ({ emitAgentEventForSession: () => undefined }),
}));

import { recordBackgroundTaskStopNote } from '../../../../src/host/services/commandCenter/backgroundTaskStopNote';
import { projectTerminalResult } from '../../../../src/host/services/commandCenter/terminalResultProjection';
import type { SessionCommandTask } from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import type { WorkspaceScope } from '../../../../src/host/runtime/workspaceScope';

function makeTask(overrides: Partial<SessionCommandTask> = {}): SessionCommandTask {
  return {
    id: 'task-1',
    sessionId: 'session-label',
    title: '周报',
    shortName: '周报',
    laneKey: 'lane-a',
    submissionKey: 'sub-a',
    prompt: 'do it',
    workspaceScope: {} as WorkspaceScope,
    status: 'cancelled',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    summary: '结果说明',
    ...overrides,
  };
}

function stopNoteRows(): Array<{ id: string; content: string; metadata: unknown }> {
  return harness.messages.filter((row) => row.id.startsWith('background-task-stopped-'));
}

describe('停止行标题：完整任务名，词边界截断，中文界面不印整句英文', () => {
  beforeEach(() => {
    harness.locale = 'zh';
    harness.messages.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('中英混排标题（cancelled 投影）：显示完整标题，不再用半截短键；[任务结果] 行仍用短键', async () => {
    await projectTerminalResult(makeTask({ title: '抓取 GUI 文档', shortName: '抓gui' }), 'cancelled');

    const notes = stopNoteRows();
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe('background-task-stopped-task-1');
    expect(notes[0].content).toBe('「抓取 GUI 文档」：这个后台任务已取消。');
    // [任务结果] 行不在本单范围：引用键原样保留。
    const resultRow = harness.messages.find((row) => row.id === 'session-task-result-task-1');
    expect(resultRow?.content).toBe('[任务结果] 抓gui｜已取消｜结果说明');
  });

  it('中英混排标题（stopped 投影）：提前停止的说明行同样用完整标题', async () => {
    await projectTerminalResult(makeTask({
      title: '抓取 docs 页面', shortName: '抓取do',
      stopped: { content: '已到步数上限，任务停止', kind: 'step_cap' },
    }), 'failed');

    const notes = stopNoteRows();
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toBe('「抓取 docs 页面」：已到步数上限，任务停止');
  });

  it('纯中文短标题（2-4 字符）显示不变', async () => {
    await projectTerminalResult(makeTask({ title: '周报', shortName: '周报' }), 'cancelled');

    expect(stopNoteRows()[0].content).toBe('「周报」：这个后台任务已取消。');
  });

  it('中文界面遇到纯英文标题退回短键；英文界面（en）用完整英文标题', async () => {
    harness.locale = 'zh';
    await projectTerminalResult(makeTask({ title: 'Fetch GUI documentation', shortName: 'GUI' }), 'cancelled');
    expect(stopNoteRows()[0].content).toBe('「GUI」：这个后台任务已取消。');

    harness.messages.length = 0;
    harness.locale = 'en';
    await projectTerminalResult(makeTask({ title: 'Fetch GUI documentation', shortName: 'GUI' }), 'cancelled');
    expect(stopNoteRows()[0].content).toBe('「Fetch GUI documentation」：This background task was cancelled.');
  });

  it('空标题退回短键，不出「」空名字', async () => {
    await projectTerminalResult(makeTask({ title: '   ', shortName: '抓取' }), 'cancelled');

    expect(stopNoteRows()[0].content).toBe('「抓取」：这个后台任务已取消。');
  });

  it('超长标题在词边界截断：截断点落在英文单词内部时退到上一个空白', async () => {
    // 前 16 个中文 + 空格 = 17 码点，第 18-30 码点是单词 documentation；24 码点处正在单词内部。
    const title = '抓取页面并整理归档到资料库里面去 documentation';
    await projectTerminalResult(makeTask({ title, shortName: '抓取3' }), 'cancelled');

    expect(stopNoteRows()[0].content).toBe('「抓取页面并整理归档到资料库里面去…」：这个后台任务已取消。');
  });

  it('超长纯中文标题：中文之间可直接下刀，24 码点后加「…」', async () => {
    const title = '一二三四五六七八九十'.repeat(3);
    await projectTerminalResult(makeTask({ title, shortName: '一二' }), 'cancelled');

    expect(stopNoteRows()[0].content).toBe(`「${'一二三四五六七八九十'.repeat(2)}一二三四…」：这个后台任务已取消。`);
  });

  it('recordBackgroundTaskStopNote 直调（后台子代理路径共用）：英文长标题同样词边界截断', async () => {
    await recordBackgroundTaskStopNote('session-label', 'Fetch the GUI documentation pages and summarise', '已停止', {
      taskId: 'task-direct', kind: 'error',
    });

    // 第 24 码点切在 pages 内部 → 退到上一个空白（GUI 之后）。
    expect(stopNoteRows()[0].content).toBe('「Fetch the GUI…」：已停止');
  });

  it('整段一个超长英文单词：退回硬截断，不给空名字', async () => {
    await recordBackgroundTaskStopNote('session-label', 'd'.repeat(30), '已停止', {
      taskId: 'task-word', kind: 'error',
    });

    expect(stopNoteRows()[0].content).toBe(`「${'d'.repeat(24)}…」：已停止`);
  });
});
