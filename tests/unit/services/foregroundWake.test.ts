import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/shared/contract';
import type { SessionCommandTask } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import {
  createForegroundWake,
  type ForegroundWakeDependencies,
} from '../../../src/host/services/commandCenter/foregroundWake';
import { WAKE_NOOP_TOOL_NAME } from '../../../src/shared/constants/agent';
import { getSessionCommandCenterBrainContextForPrompt } from '../../../src/host/app/sessionCommandCenterBrain';
import * as brain from '../../../src/host/app/sessionCommandCenterBrain';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { logger } from '../../../src/host/services/infra/logger';
import { narrowToolNamesByRunPolicy } from '../../../src/host/tools/runToolPolicy';

// N-FIX-BG-WAKE-TURN-KEEPS-EDIT-WRITE：隐藏唤醒轮（无用户消息）不得携带的写入/生成/派发面
const WAKE_BANNED_TOOL_NAMES = [
  'Edit',
  'Write',
  'DocEdit',
  'docx_generate',
  'excel_generate',
  'ExcelAutomate',
  'mail_draft',
  'schedule_task',
  'delegate_session',
  'delegate_task',
  'spawn_agent',
] as const;

const resolverState = vi.hoisted(() => ({ getDefinition: vi.fn(), execute: vi.fn() }));
vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => resolverState,
}));
// 常量已不导出，经单一真源函数取基块（空白轮次不命中回合级规则）
const SESSION_COMMAND_CENTER_BRAIN_CONTEXT = getSessionCommandCenterBrainContextForPrompt('')[0];
import {
  BACKGROUND_WAKE_DEFER_NOTICE_MS,
  BACKGROUND_WAKE_DEFER_PROGRESS,
  MAX_CONSECUTIVE_WAKES,
} from '../../../src/shared/constants/sessionCommandCenter';

const sendMessage = vi.fn().mockResolvedValue(undefined);
const orchestrator = {
  isProcessing: vi.fn(() => false),
  sendMessage,
};
let agentEventObserver: ((sessionId: string, event: AgentEvent, taskId?: string) => void) | undefined;
let stateChangeListener: ((event: { sessionId: string; data?: unknown }) => void) | undefined;
const manager = {
  getSessionState: vi.fn(() => ({ status: 'idle' })),
  getWaitingQueue: vi.fn((): string[] => []),
  hasActivePrimaryRun: vi.fn(() => false),
  getOrCreateCurrentOrchestrator: vi.fn(() => orchestrator),
  setSessionContext: vi.fn(),
  setWorkingDirectory: vi.fn(),
  on: vi.fn((_event: 'state_change', listener: typeof stateChangeListener) => {
    stateChangeListener = listener;
  }),
  onRunIdle: vi.fn(),
  emitAgentEventForSession: vi.fn(),
  observeAgentEvents: vi.fn((observer: typeof agentEventObserver) => {
    agentEventObserver = observer;
    return () => { agentEventObserver = undefined; };
  }),
};
const wakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};
const session = {
  id: 'session-a',
  title: '会话',
  modelConfig: { provider: 'openai', model: 'test' },
  type: 'chat' as const,
  workingDirectory: '/tmp/project',
  createdAt: 1,
  updatedAt: 1,
  messages: [{ id: 'user-1', role: 'user' as const, content: '开始', timestamp: 1 }],
  todos: [],
  messageCount: 1,
};

function task(id = 'task-1'): SessionCommandTask {
  return {
    id,
    sessionId: 'session-a',
    title: '生成报告',
    shortName: '报告',
    laneKey: 'report',
    submissionKey: id,
    prompt: '生成报告',
    workspaceScope: {} as SessionCommandTask['workspaceScope'],
    status: 'completed',
    attempt: 1,
    createdAt: 1,
    updatedAt: 2,
    summary: '报告已生成。',
  };
}

function dependencies(overrides: Partial<ForegroundWakeDependencies> = {}): ForegroundWakeDependencies {
  return {
    getTaskManager: () => manager as unknown as ReturnType<ForegroundWakeDependencies['getTaskManager']>,
    loadSession: vi.fn(async () => session),
    hasQueuedUserInput: vi.fn(() => false),
    isVoiceSession: vi.fn(() => false),
    recordWakeFailureNote: vi.fn(async () => undefined),
    recordWakeDeferredNote: vi.fn(async () => undefined),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
    logger: wakeLogger,
    ...overrides,
  };
}

function fakeTimer() {
  let now = 0;
  let nextId = 1;
  const scheduledDelays: number[] = [];
  const timers = new Map<number, { dueAt: number; callback: () => void }>();
  return {
    scheduledDelays,
    setTimeout: (callback: () => void, delayMs: number): number => {
      const id = nextId;
      nextId += 1;
      scheduledDelays.push(delayMs);
      timers.set(id, { dueAt: now + delayMs, callback });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    advanceBy: (durationMs: number): void => {
      now += durationMs;
      for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)) {
        if (timer.dueAt > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

describe('foreground task-result wake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessage.mockResolvedValue(undefined);
    orchestrator.isProcessing.mockReturnValue(false);
    manager.getSessionState.mockReturnValue({ status: 'idle' });
    manager.getWaitingQueue.mockReturnValue([]);
    manager.hasActivePrimaryRun.mockReturnValue(false);
    manager.getOrCreateCurrentOrchestrator.mockReturnValue(orchestrator);
    agentEventObserver = undefined;
    stateChangeListener = undefined;
  });

  it.each(['completed', 'failed'] as const)('wakes for %s with hidden input, a read-only tool face and no foreground brain block', async (status) => {
    const wake = createForegroundWake(dependencies());

    await wake(task(), status);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [prompt, attachments, options] = sendMessage.mock.calls[0];
    expect(prompt).toContain(status === 'completed' ? '已完成' : '已失败');
    expect(prompt).toContain('报告已生成');
    expect(attachments).toBeUndefined();
    expect(options).toMatchObject({
      mode: 'normal',
      inputHistoryVisibility: 'meta',
      runRegistration: 'auxiliary',
      maxIterations: 4,
    });
    expect(options.historyVisibility).toBeUndefined();
    // N-FIX-BG-WAKE-TURN-KEEPS-EDIT-WRITE：无用户消息的唤醒轮是正向白名单——前台基面自带的
    // Write/Edit（以及任何未来按 prompt 进面的写入/生成/派发工具）必须被滤掉
    for (const banned of WAKE_BANNED_TOOL_NAMES) {
      expect(options.allowedToolNames).not.toContain(banned);
    }
    for (const allowed of ['Read', 'Glob', 'Grep', 'ListDirectory', 'task_status', 'cancel_task', 'steer_task', 'AskUserQuestion', WAKE_NOOP_TOOL_NAME]) {
      expect(options.allowedToolNames).toContain(allowed);
    }
    expect(options.turnSystemContext?.join('\n')).toContain('<background_task_hidden_wake>');
    expect(options.turnSystemContext?.join('\n')).toContain(`只调用 ${WAKE_NOOP_TOOL_NAME}`);
    // 前台 brain 块（教模型 Edit/Write/delegate_task）不再进唤醒轮，契约与只读工具面一致
    expect(options.turnSystemContext).not.toContain(SESSION_COMMAND_CENTER_BRAIN_CONTEXT);
    expect(options.turnSystemContext?.join('\n')).not.toContain('<session_command_center>');
    expect(options.turnSystemContext?.join('\n')).not.toContain('Edit 或 Write');
    expect(options.turnSystemContext?.join('\n')).toContain('Read/Grep/ListDirectory');
    expect(manager.setSessionContext).toHaveBeenCalledWith('session-a', session.messages);
  });

  // 正常前台轮的工具面必须原样：点名 docx/xlsx 的 prompt 仍拿到 Edit/Write/生成工具；
  // 同一套带写入工具的面喂进唤醒轮（模拟未来调用方把 prompt 传进 brain）只剩白名单。
  it('keeps office-deliverable foreground turns unchanged while the wake face filters their write tools', async () => {
    const officePrompt = 'write report.docx and summary.xlsx for me';
    const foreground = brain.withSessionCommandCenterBrain({ mode: 'normal' }, officePrompt);
    for (const name of ['Edit', 'Write', 'docx_generate', 'excel_generate', 'DocEdit']) {
      expect(foreground.allowedToolNames).toContain(name);
    }

    const buildBrain = vi.spyOn(brain, 'withSessionCommandCenterBrain').mockReturnValueOnce(foreground);
    try {
      await createForegroundWake(dependencies())(task(), 'completed');
      const allowed = sendMessage.mock.calls[0][2].allowedToolNames;
      for (const banned of WAKE_BANNED_TOOL_NAMES) {
        expect(allowed).not.toContain(banned);
      }
      expect(allowed).toContain('Read');
      expect(allowed).toContain(WAKE_NOOP_TOOL_NAME);
      expect(sendMessage.mock.calls[0][2].turnSystemContext).not.toContain(SESSION_COMMAND_CENTER_BRAIN_CONTEXT);
    } finally {
      buildBrain.mockRestore();
    }
  });

  // 注册表侧注入：给前台基面塞一个带 allowInTextForeground 的写入工具，正常前台轮拿得到、唤醒轮必须滤掉
  it('filters a write tool injected into the foreground registry base set', async () => {
    const registry = getProtocolRegistry();
    registry.register({
      name: 'wake_write_probe',
      description: 'synthetic write tool used only by this test',
      inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: { type: 'string' },
      category: 'fs',
      permissionLevel: 'write',
      readOnly: false,
      allowInTextForeground: true,
    }, () => Promise.reject(new Error('probe tool never executes')));
    try {
      const foreground = brain.withSessionCommandCenterBrain({ mode: 'normal' }, '');
      expect(foreground.allowedToolNames).toContain('wake_write_probe');
      await createForegroundWake(dependencies())(task(), 'completed');
      expect(sendMessage.mock.calls[0][2].allowedToolNames).not.toContain('wake_write_probe');
    } finally {
      registry.unregister('wake_write_probe');
    }
  });

  it('does not wake a cancelled task', async () => {
    const wake = createForegroundWake(dependencies());
    await wake(task(), 'cancelled');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(['delegate_task', 'spawn_agent'])('blocks wake-turn %s through the real ToolExecutor and logs the policy', async (toolName) => {
    resolverState.getDefinition.mockReturnValue({
      name: toolName,
      description: 'start work',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: false,
      permissionLevel: 'write',
    });
    const warn = vi.spyOn(Object.getPrototypeOf(logger) as typeof logger, 'warn');
    try {
      await createForegroundWake(dependencies())(task(), 'completed');
      const options = sendMessage.mock.calls[0][2];
      const executor = new ToolExecutor({
        requestPermission: async () => true,
        workingDirectory: '/tmp/project',
      });
      const result = await executor.execute(toolName, {}, options);
      expect(result.success).toBe(false);
      expect(result.metadata?.code).toBe('TOOL_DISABLED_FOR_RUN');
      expect(resolverState.execute).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('Tool blocked by run tool policy', { toolName });
      expect(wakeLogger.warn).toHaveBeenCalledWith(
        'Foreground wake dispatch tools denied by run tool policy',
        { sessionId: 'session-a', taskId: 'task-1', deniedToolNames: options.deniedToolNames },
      );
      expect(options.deniedToolNames).toContain(toolName);
      expect(narrowToolNamesByRunPolicy([toolName], options)).toEqual([]);
      for (const control of ['steer_task', 'cancel_task', 'task_status']) {
        expect(options.deniedToolNames).not.toContain(control);
      }
      const contract = options.turnSystemContext.find((text: string) => text.startsWith('<background_task_hidden_wake>'));
      expect(contract).not.toContain('delegate_task');
      expect(contract).toContain('不是用户消息，不代表新的请求或授权');
      expect(contract).toContain('等待用户下一条消息');
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['delegate_task', 'spawn_agent'])('leaves ordinary user-turn %s unaffected by the wake deny', async (toolName) => {
    resolverState.getDefinition.mockReturnValue({
      name: toolName,
      description: 'start work',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: false,
      permissionLevel: 'write',
    });
    resolverState.execute.mockResolvedValue({ success: true, output: 'started' });
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/project',
    });
    const result = await executor.execute(toolName, {}, { sessionId: 'session-a' });
    expect(result.success).toBe(true);
    expect(result.metadata?.code).not.toBe('TOOL_DISABLED_FOR_RUN');
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('preserves existing brain denies while adding wake dispatch denies without duplicates', async () => {
    const brainOptions = brain.withSessionCommandCenterBrain({ deniedToolNames: ['Read', 'delegate_task'] });
    const buildBrain = vi.spyOn(brain, 'withSessionCommandCenterBrain').mockReturnValueOnce(brainOptions);
    try {
      await createForegroundWake(dependencies())(task(), 'completed');
      expect(sendMessage.mock.calls[0][2].deniedToolNames).toEqual(['Read', 'delegate_task', 'spawn_agent']);
    } finally {
      buildBrain.mockRestore();
    }
  });

  it('does not wake while the foreground session is busy', async () => {
    manager.hasActivePrimaryRun.mockReturnValue(true);
    const wake = createForegroundWake(dependencies());
    await wake(task(), 'completed');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(wakeLogger.info).toHaveBeenCalledWith(
      'Foreground wake deferred: session busy',
      expect.objectContaining({ sessionId: 'session-a' }),
    );
  });

  it('keeps real foreground tool progress while a wake is deferred, and rewrites only plain thinking', async () => {
    manager.hasActivePrimaryRun.mockReturnValue(true);
    const clock = fakeTimer();
    const wake = createForegroundWake(dependencies({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    }));
    await wake(task(), 'completed');

    manager.emitAgentEventForSession.mockClear();
    agentEventObserver?.('session-a', {
      type: 'task_progress',
      data: {
        turnId: 'turn-foreground',
        phase: 'tool_running',
        step: '执行命令',
        tool: 'Bash',
        toolIndex: 1,
        toolTotal: 3,
        progress: 40,
      },
    });
    expect(manager.emitAgentEventForSession).not.toHaveBeenCalled();

    agentEventObserver?.('session-a', {
      type: 'task_progress',
      data: { turnId: 'turn-foreground', phase: 'thinking', step: '分析请求中...' },
    });
    expect(manager.emitAgentEventForSession).toHaveBeenCalledTimes(1);
    expect(manager.emitAgentEventForSession).toHaveBeenCalledWith('session-a', {
      type: 'task_progress',
      data: { turnId: 'turn-foreground', phase: 'thinking', step: BACKGROUND_WAKE_DEFER_PROGRESS.completed },
    });
  });

  it('emits deferred status immediately and one visible note at the cap', async () => {
    manager.hasActivePrimaryRun.mockReturnValue(true);
    const clock = fakeTimer();
    const recordWakeDeferredNote = vi.fn(async (_sessionId: string, _content: string, _detail: { taskId: string; outcome: 'completed' | 'failed'; title?: string }) => undefined);
    const visibleTitle = '运行 sleep 40 并输出 X';
    const internalShortName = 'slee';
    const wake = createForegroundWake(dependencies({
      recordWakeDeferredNote,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    }));

    await wake({ ...task(), title: visibleTitle, shortName: internalShortName }, 'completed');

    expect(manager.emitAgentEventForSession).toHaveBeenCalledWith('session-a', {
      type: 'task_progress',
      data: expect.objectContaining({
        phase: 'thinking',
        step: BACKGROUND_WAKE_DEFER_PROGRESS.completed,
      }),
    });
    expect(clock.scheduledDelays).toEqual([BACKGROUND_WAKE_DEFER_NOTICE_MS]);
    expect(clock.scheduledDelays[0]).toBeLessThanOrEqual(BACKGROUND_WAKE_DEFER_NOTICE_MS);
    expect(recordWakeDeferredNote).not.toHaveBeenCalled();

    manager.emitAgentEventForSession.mockClear();
    agentEventObserver?.('session-a', {
      type: 'task_progress',
      data: { turnId: 'turn-foreground', phase: 'thinking', step: '分析请求中...' },
    });
    expect(manager.emitAgentEventForSession).toHaveBeenCalledWith('session-a', {
      type: 'task_progress',
      data: {
        turnId: 'turn-foreground',
        phase: 'thinking',
        step: '后台任务已完成，等待汇报',
      },
    });

    clock.advanceBy(BACKGROUND_WAKE_DEFER_NOTICE_MS - 1);
    expect(recordWakeDeferredNote).not.toHaveBeenCalled();
    clock.advanceBy(1);
    expect(recordWakeDeferredNote).toHaveBeenCalledTimes(1);
    expect(recordWakeDeferredNote).toHaveBeenCalledWith(
      'session-a',
      `后台任务「${visibleTitle}」已完成，结果见上方的任务结果；当前步骤结束后，我会继续汇报。`,
      { taskId: 'task-1', outcome: 'completed', title: visibleTitle },
    );
    expect(recordWakeDeferredNote.mock.calls[0]?.[1]).not.toContain(`「${internalShortName}」`);
    manager.hasActivePrimaryRun.mockReturnValue(false);
    stateChangeListener?.({ sessionId: 'session-a', data: { status: 'idle' } });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    clock.advanceBy(BACKGROUND_WAKE_DEFER_NOTICE_MS);
    expect(recordWakeDeferredNote).toHaveBeenCalledTimes(1);
  });

  it('clears a superseded task timer and surfaces only the latest failed result', async () => {
    manager.hasActivePrimaryRun.mockReturnValue(true);
    const clock = fakeTimer();
    const recordWakeDeferredNote = vi.fn(async () => undefined);
    const wake = createForegroundWake(dependencies({
      recordWakeDeferredNote,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    }));

    await wake(task('task-old'), 'completed');
    await wake({ ...task('task-new'), shortName: '新任务' }, 'failed');
    clock.advanceBy(BACKGROUND_WAKE_DEFER_NOTICE_MS);

    expect(recordWakeDeferredNote).toHaveBeenCalledTimes(1);
    expect(recordWakeDeferredNote).toHaveBeenCalledWith(
      'session-a',
      expect.stringContaining('「生成报告」已失败'),
      { taskId: 'task-new', outcome: 'failed', title: '生成报告' },
    );
    expect(manager.emitAgentEventForSession).toHaveBeenLastCalledWith(
      'session-a',
      expect.objectContaining({
        type: 'task_progress',
        data: expect.objectContaining({ step: BACKGROUND_WAKE_DEFER_PROGRESS.failed }),
      }),
    );
  });

  it('does not wake a live voice session', async () => {
    const wake = createForegroundWake(dependencies({ isVoiceSession: () => true }));
    await wake(task(), 'completed');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(wakeLogger.info).toHaveBeenCalledWith(
      'Foreground wake skipped: voice session',
      expect.objectContaining({ sessionId: 'session-a' }),
    );
  });

  it('does not wake when a durable user input is queued', async () => {
    const wake = createForegroundWake(dependencies({ hasQueuedUserInput: () => true }));
    await wake(task(), 'completed');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('caps consecutive hidden wakes until a new visible user message arrives', async () => {
    const wake = createForegroundWake(dependencies());
    for (let index = 0; index < MAX_CONSECUTIVE_WAKES + 1; index += 1) {
      await wake(task(`task-${index}`), 'completed');
    }

    expect(sendMessage).toHaveBeenCalledTimes(MAX_CONSECUTIVE_WAKES);
    expect(wakeLogger.warn).toHaveBeenCalledWith(
      'Foreground wake skipped: consecutive wake limit reached',
      expect.objectContaining({ consecutive: MAX_CONSECUTIVE_WAKES }),
    );
  });

  it('swallows a failed wake turn, logs the cause and records a plain-language note', async () => {
    sendMessage.mockRejectedValueOnce(new Error('model unavailable'));
    const recordWakeFailureNote = vi.fn(async () => undefined);
    const noted = createForegroundWake(dependencies({ recordWakeFailureNote }));
    await expect(noted(task(), 'completed')).resolves.toBeUndefined();
    expect(wakeLogger.warn).toHaveBeenCalledWith(
      'Foreground wake failed: wake turn failed',
      expect.objectContaining({ message: 'model unavailable' }),
    );
    expect(recordWakeFailureNote).toHaveBeenCalledWith(
      'session-a',
      expect.stringContaining('任务结果'),
      { taskId: 'task-1', reason: 'turn_error', title: '报告' },
    );
  });

  it('logs owner-missing wake failures under a distinct reason', async () => {
    sendMessage.mockRejectedValueOnce(new Error('Durable Run run-1 has no live owner lease'));
    await createForegroundWake(dependencies())(task(), 'completed');
    expect(wakeLogger.warn).toHaveBeenCalledWith(
      'Foreground wake failed: owner missing',
      expect.objectContaining({
        taskId: 'task-1',
        message: 'Durable Run run-1 has no live owner lease',
      }),
    );
  });

  it('records the note once when the wake turn resolves after capturing a terminal RUN_FAILED error', async () => {
    sendMessage.mockImplementationOnce(async (_prompt: string, _attachments: unknown, options: { terminalErrorSink?: (data: unknown) => void }) => {
      options.terminalErrorSink?.({ code: 'RUN_FAILED', message: 'model 502 bad gateway' });
    });
    const recordWakeFailureNote = vi.fn(async () => undefined);
    await createForegroundWake(dependencies({ recordWakeFailureNote }))(task(), 'completed');

    expect(wakeLogger.warn).toHaveBeenCalledTimes(2); // dispatch policy + one failure
    expect(wakeLogger.warn).toHaveBeenCalledWith(
      'Foreground wake failed: wake turn failed',
      expect.objectContaining({ sessionId: 'session-a', taskId: 'task-1', message: 'model 502 bad gateway' }),
    );
    expect(recordWakeFailureNote).toHaveBeenCalledTimes(1);
    expect(recordWakeFailureNote).toHaveBeenCalledWith(
      'session-a',
      expect.stringContaining('任务结果'),
      { taskId: 'task-1', reason: 'turn_error', title: '报告' },
    );
  });

  it('does not record a duplicate note when both terminalErrorSink and a thrown exception occur', async () => {
    sendMessage.mockImplementationOnce(async (_prompt: string, _attachments: unknown, options: { terminalErrorSink?: (data: unknown) => void }) => {
      options.terminalErrorSink?.({ message: 'first captured error' });
      options.terminalErrorSink?.({ message: 'second captured error' });
      throw new Error('rethrown error');
    });
    const recordWakeFailureNote = vi.fn(async () => undefined);
    await createForegroundWake(dependencies({ recordWakeFailureNote }))(task(), 'completed');

    expect(wakeLogger.warn).toHaveBeenCalledTimes(2); // dispatch policy + one failure
    expect(wakeLogger.warn).toHaveBeenCalledWith(
      'Foreground wake failed: wake turn failed',
      expect.objectContaining({ message: 'first captured error' }),
    );
    expect(recordWakeFailureNote).toHaveBeenCalledTimes(1);
  });

  // N-SUBAGENT-INPUT：用户绕过团长直接给任务补过话，收工摘要要带一句让团长汇总时不漏
  it('mentions how many times the user supplemented the task directly', async () => {
    const wake = createForegroundWake(dependencies());
    await wake({ ...task(), userInputCount: 2 }, 'completed');
    expect(sendMessage.mock.calls[0][0]).toContain('期间用户直接给它补了 2 句');

    await wake(task('task-2'), 'completed');
    expect(sendMessage.mock.calls[1][0]).not.toContain('期间用户');
  });

  // N-FIX-WEBFETCH-BLOCK-PRIVATE-NET-FU2：240 字 summary 截断了 SSRF 拒绝提示里的
  // 「改走 Bash curl 审批」整句（FB-577）；唤醒提示改读 1500 封顶的 resultText。
  it('quotes the full model-facing result text in the wake prompt', async () => {
    const hint = 'use a Bash curl command instead — it asks the user for approval.';
    // 铺垫恰好 240 字：旧口径（summary 硬切）必然丢句，resultText 必须原样带到
    const conclusion = `${'铺垫。'.repeat(80)}${hint}后续不再赘述。`;
    expect(conclusion.slice(0, 240)).not.toContain(hint);

    const wake = createForegroundWake(dependencies());
    await wake({
      ...task(),
      summary: conclusion.slice(0, 240),
      resultText: conclusion,
    }, 'failed');
    const prompt = sendMessage.mock.calls[0][0] as string;
    expect(prompt).toContain('已失败');
    expect(prompt).toContain(conclusion);
    expect(prompt).toContain(hint);
  });

  it('falls back to the 240-char summary when the task has no resultText (legacy shape)', async () => {
    const wake = createForegroundWake(dependencies());
    await wake({ ...task(), summary: 'x'.repeat(240) }, 'completed');
    expect(sendMessage.mock.calls[0][0]).toContain('x'.repeat(240));
  });
});
