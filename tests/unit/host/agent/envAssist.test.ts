// ============================================================================
// MCP 权限范围不足 → 引擎在 tool_call_end 之后发 connector_required(reason:'insufficient_scope')
// （N-CONNECTOR-POLISH-AUDIT-FU4-SCOPE）。ctx.onEvent 是 agentAppService(TaskManager) 与
// web routes/agent 两条发射路径共用的源头。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '../../../../src/shared/contract';
import { ToolExecutionEngine } from '../../../../src/host/agent/runtime/toolExecutionEngine';
import { AntiPatternDetector } from '../../../../src/host/agent/antiPattern/detector';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';
import { registerEnvAssistHandlers } from '../../../../src/host/ipc/envAssist.ipc';
import { handlers } from '../../../../src/host/platform/ipcRegistry';
import { ipcHost } from '../../../../src/host/platform';
import { IPC_DOMAINS } from '../../../../src/shared/ipc';
import type { Message } from '../../../../src/shared/contract';
import type { EnvAssistNotice } from '../../../../src/shared/contract/envAssist';
import {
  AUTOMATION_FAILURE_CASES,
  appleEventsDeniedError,
  protoFailure,
  runConnectorToolFailure,
} from './envAssistConnectorPath';

const serviceMocks = vi.hoisted(() => ({
  messages: [] as Message[],
  manager: {
    getMessages: vi.fn(async () => serviceMocks.messages),
    addMessageToSession: vi.fn(async (_session: string, message: Message) => {
      const index = serviceMocks.messages.findIndex((m) => m.id === message.id);
      if (index < 0) serviceMocks.messages.push(message); else serviceMocks.messages[index] = message;
    }),
  },
  langfuse: {
    startNestedSpan: vi.fn(),
    endSpan: vi.fn(),
  },
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({ getSessionManager: () => serviceMocks.manager }));
vi.mock('../../../../src/host/services', () => ({
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  getSessionManager: () => serviceMocks.manager,
  getLangfuseService: () => serviceMocks.langfuse,
  BudgetAlertLevel: {},
}));

vi.mock('../../../../src/host/permissions/envAssist/settingsPane', () => ({ canOpenEnvSettings: () => true, openEnvSettings: vi.fn() }));

// 真实连接器失败路径：runAppleScript 假掉（真实 -1743 拒绝文本），其余（含
// describeAppleScriptFailure / isAppleScriptFailure）保持真实现。
const osascriptRunner = vi.hoisted(() => ({ runAppleScript: vi.fn() }));
vi.mock('../../../../src/host/connectors/native/osascript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/connectors/native/osascript')>();
  return { ...actual, runAppleScript: osascriptRunner.runAppleScript };
});

vi.mock('../../../../src/host/services/citation/citationService', () => ({
  getCitationService: () => ({
    extractAndStore: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../../../../src/host/services/git/fileWatcherService', () => ({
  getFileWatcherService: () => ({
    getRecentExternalChanges: vi.fn().mockReturnValue([]),
    markAsAgentModified: vi.fn(),
  }),
}));

vi.mock('../../../../src/host/services/git/gitStatusService', () => ({
  getGitStatusService: () => ({
    onPostToolUse: vi.fn(),
  }),
}));

vi.mock('../../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getToolAnnotationsMap: () => new Map(),
    getToolDefinitions: () => [],
  }),
}));

function makeRuntimeContext(execute: RuntimeContext['toolExecutor']['execute']): RuntimeContext {
  return {
    systemPrompt: '',
    modelConfig: { provider: 'openai', model: 'gpt-test' } as never,
    toolExecutor: { execute } as never,
    messages: [],
    onEvent: vi.fn(),
    modelRouter: {} as never,
    maxIterations: 10,
    workingDirectory: '/tmp/code-agent-test',
    isDefaultWorkingDirectory: false,
    sessionId: 'env-assist-session',
    runId: 'env-assist-run',
    persistLongTermMemory: true,
    includeRecentConversations: true,
    circuitBreaker: {
      recordFailure: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      generateWarningMessage: vi.fn(),
      generateUserErrorMessage: vi.fn(),
    } as never,
    antiPatternDetector: new AntiPatternDetector(),
    goalTracker: { recordAction: vi.fn() } as never,
    nudgeManager: {
      trackModifiedFile: vi.fn(),
      checkProgressState: vi.fn(),
      checkPostForceExecute: vi.fn(),
    } as never,
    hookMessageBuffer: {} as never,
    messageHistoryCompressor: {} as never,
    autoCompressor: {} as never,
    compressionPipeline: {} as never,
    telemetryAdapter: {
      onTurnStart: vi.fn(),
      onModelCall: vi.fn(),
      onToolCallStart: vi.fn(),
      onToolCallEnd: vi.fn(),
      onTurnEnd: vi.fn(),
    },
    turnTrace: {
      setTurn: vi.fn(),
      record: vi.fn(),
      flush: vi.fn(),
      getEvents: vi.fn().mockReturnValue([]),
    } as never,
    turn: TurnState.forTest({
      currentIterationSpanId: 'iteration-1',
      currentTurnId: 'turn-1',
      turnStartTime: Date.now(),
      effortLevel: 'medium' as never,
    }),
    autoApprovePlan: false,
    enableHooks: true,
    maxStopHookRetries: 0,
    maxToolCallRetries: 0,
    enableToolDeferredLoading: false,
    maxMode: false,
    maxModeCandidates: 1,
    maxStructuredOutputRetries: 0,
    stepByStepMode: false,
    turnQualityState: {},
    goalEvidenceState: { bounces: 0 },
    control: ControlState.forTest(),
    budgetScope: 'foreground',
    consecutiveErrors: 0,
    stats: RunStatsState.forTest({
      traceId: 'trace-1',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      runStartTime: Date.now(),
      totalTokensUsed: 0,
      totalToolCallCount: 0,
    } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    MAX_CONSECUTIVE_COMPACTS: 3,
    contextHealth: ContextHealthState.forTest({ persistentSystemContext: [] } as never),
    artifact: ArtifactState.forTest(),
    enableDeliveryCritic: false,
  };
}

function makeEngine(execute: RuntimeContext['toolExecutor']['execute']) {
  const ctx = makeRuntimeContext(execute);
  const engine = new ToolExecutionEngine(ctx);
  engine.setModules(
    {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    } as never,
    { emitTaskProgress: vi.fn() } as never,
    { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false), generateAutoContinuationPrompt: vi.fn() } as never,
  );
  return { ctx, engine };
}


const failure = (): ToolResult => ({ toolCallId: '', success: false, error: 'osascript -1743 Apple events TCC', metadata: { code: 'not_authorized' } });
const events = (ctx: RuntimeContext) => (ctx.onEvent as ReturnType<typeof vi.fn>).mock.calls.map(([event]) => event);

beforeEach(() => { serviceMocks.messages.length = 0; vi.clearAllMocks(); vi.stubEnv('SSH_CONNECTION', ''); vi.stubEnv('SSH_CLIENT', ''); vi.stubEnv('SSH_TTY', ''); });

describe('environment notices through the production tool_call_end path', () => {
  it('tells the main model that the permission card was shown without quotable error copy', async () => {
    const { ctx, engine } = makeEngine(vi.fn(async () => ({ ...failure(), output: 'osascript -1743 Apple events TCC' })));
    const results = await engine.executeToolsWithHooks([{ id: 'guidance', name: 'calendar', arguments: { action: 'list_events' } }]);
    const end = events(ctx).find((e) => e.type === 'tool_call_end');
    expect(results).toHaveLength(1);
    for (const result of [results[0], end.data]) {
      const text = [result.error, result.output].filter(Boolean).join(' ');
      expect(text).not.toMatch(/-1743|osascript|Apple events|TCC|Permission is needed to continue/i);
      expect(text).toMatch(/permission card.*already been shown/i);
      expect(text).toMatch(/do not.*quote/i);
      expect(text).toContain("user's language");
      expect(text).toContain('ask again');
    }
  });

  it('deduplicates repeat/concurrent failures per run, persists replay, and refreshes the snapshot', async () => {
    const { ctx, engine } = makeEngine(vi.fn(async () => failure()));
    await engine.executeToolsWithHooks([{ id: 'calendar-1', name: 'calendar', arguments: { action: 'list_events', title: 'Reminder', text: 'Reminder' } }]);
    const first = serviceMocks.messages[0].metadata!.envAssist!;
    await engine.executeToolsWithHooks([{ id: 'calendar-2', name: 'calendar', arguments: { action: 'list_events', title: 'Reminder', text: 'Reminder' } }]);
    const notices = events(ctx).filter((e) => e.type === 'env_assist_notice');
    expect(notices).toHaveLength(1);
    expect(new Set(notices.map((e) => e.data.id)).size).toBe(1);
    expect(serviceMocks.messages).toHaveLength(1);
    expect(serviceMocks.messages[0].metadata!.envAssist!.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(serviceMocks.messages[0].metadata!.envAssist).toMatchObject({ class: 'perm_automation', target: { id: 'calendar' } });
    const ends = events(ctx).filter((e) => e.type === 'tool_call_end');
    expect(ends).toHaveLength(2);
    expect(JSON.stringify(ends)).not.toMatch(/-1743|osascript|Apple events|TCC/i);
    // Another executor in the same run, like a delegated worker, shares the persisted id.
    const next = makeEngine(vi.fn(async () => failure()));
    await next.engine.executeToolsWithHooks([{ id: 'calendar-3', name: 'calendar', arguments: { action: 'list_events', title: 'Reminder', text: 'Reminder' } }]);
    expect(events(next.ctx).filter((e) => e.type === 'env_assist_notice')).toHaveLength(0);
  });

  // 不再手搓 metadata.code：真工具模块 + 真原生连接器 + 假 runAppleScript（-1743），
  // code 必须由被测的 osascript 失败分支真实产出，缺 code 的回归在这里直接红。
  it.each(['calendar', 'mail', 'reminders', 'reminders_create'] as const)('covers %s through the real connector failure path', async (tool) => {
    const { args, app, target } = AUTOMATION_FAILURE_CASES[tool];
    osascriptRunner.runAppleScript.mockReset();
    osascriptRunner.runAppleScript.mockRejectedValue(appleEventsDeniedError(app));
    const moduleResult = await runConnectorToolFailure(tool, 'env-assist-session');
    expect(moduleResult.ok).toBe(false);
    if (moduleResult.ok) return;
    const contractFailure = protoFailure(moduleResult);
    expect(contractFailure.metadata.code).toBe('not_authorized');
    const { ctx, engine } = makeEngine(vi.fn(async () => ({ toolCallId: '', ...contractFailure })));
    await engine.executeToolsWithHooks([{ id: `${tool}-1`, name: tool, arguments: args }]);
    // 同 run 重试（模型再点一次工具）：仍只发一张卡、一个持久化 id。
    await engine.executeToolsWithHooks([{ id: `${tool}-2`, name: tool, arguments: args }]);
    const notices = events(ctx).filter((e) => e.type === 'env_assist_notice');
    expect(notices).toHaveLength(1);
    expect(new Set(notices.map((e) => e.data.id)).size).toBe(1);
    expect(notices[0].data).toMatchObject({ class: 'perm_automation', target: { id: target } });
    expect(notices[0].data.id).toBe(`env-assist-run|perm_automation|${target}`);
    expect(serviceMocks.messages).toHaveLength(1);
  });

  it.each([
    ['screenshot', { failureCause: 'screen_recording_permission' }, 'perm_screen_recording'],
    ['computer_use', { failureKind: 'permission_denied' }, 'perm_accessibility'],
    ['computer_use', { failureKind: 'ax_unavailable' }, 'perm_accessibility'],
  ] as const)('classifies %s through the production entry', async (name, metadata, blocker) => {
    // 这些权限语义只存在于 macOS（classify 对非 darwin/无显示会话按设计不出卡）；
    // Linux CI 上必须钉住 darwin 平台语义，否则 classify 正确返回 null 而测试假红。
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const { ctx, engine } = makeEngine(vi.fn(async () => ({ toolCallId: '', success: false, error: 'permission needed', metadata })));
      await engine.executeToolsWithHooks([{ id: String(name), name: String(name), arguments: { action: 'screenshot' } }]);
      expect(events(ctx).find((e) => e.type === 'env_assist_notice')?.data.class).toBe(blocker);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('does not confuse Neo protected-target or per-action consent denials with system permissions', async () => {
    for (const blockedReason of ['protected app', 'approval required']) {
      const { ctx, engine } = makeEngine(vi.fn(async () => ({ toolCallId: '', success: false, error: 'permission denied', metadata: { failureKind: 'permission_denied', computerSurface: { blockedReason } } })));
      await engine.executeToolsWithHooks([{ id: blockedReason, name: 'computer_use', arguments: { action: 'screenshot' } }]);
      expect(events(ctx).filter((e) => e.type === 'env_assist_notice')).toHaveLength(0);
    }
  });

  it('serializes concurrent emitters in the same run before persisting the shared notice', async () => {
    const parent = makeEngine(vi.fn(async () => failure()));
    const sibling = makeEngine(vi.fn(async () => failure()));
    await Promise.all([
      parent.engine.executeToolsWithHooks([{ id: 'parallel-1', name: 'calendar', arguments: { action: 'list_events' } }]),
      sibling.engine.executeToolsWithHooks([{ id: 'parallel-2', name: 'calendar', arguments: { action: 'list_events' } }]),
    ]);
    expect([...events(parent.ctx), ...events(sibling.ctx)].filter((e) => e.type === 'env_assist_notice')).toHaveLength(1);
    expect(serviceMocks.messages).toHaveLength(1);
  });

  it('does not classify successes, other classes, or Neo permission denials', async () => {
    for (const result of [{ success: true }, { success: false, metadata: { code: 'PERMISSION_DENIED' } }, { success: false, metadata: { code: 'quota_exhausted' } }]) {
      const { ctx, engine } = makeEngine(vi.fn(async () => ({ toolCallId: '', ...result })));
      await engine.executeToolsWithHooks([{ id: 'other', name: 'calendar', arguments: { action: 'list_events', title: 'Reminder', text: 'Reminder' } }]);
      expect(events(ctx).filter((e) => e.type === 'env_assist_notice')).toHaveLength(0);
    }
  });

  it('routes the card click through the real IPC handler and rejects forged ids, kinds and panes', async () => {
    const { engine } = makeEngine(vi.fn(async () => failure()));
    await engine.executeToolsWithHooks([{ id: 'calendar', name: 'calendar', arguments: { action: 'list_events', title: 'Reminder', text: 'Reminder' } }]);
    const notice = serviceMocks.messages[0].metadata!.envAssist!;
    vi.spyOn(ipcHost, 'handle').mockImplementation((channel, handler) => { handlers.set(channel, handler); });
    const opener = vi.fn(async () => true);
    registerEnvAssistHandlers({ available: () => true, open: opener, findNotice: async (id) => serviceMocks.messages.find((m) => m.metadata?.envAssist?.id === id)?.metadata?.envAssist });
    const invoke = (payload: unknown) => handlers.get(IPC_DOMAINS.ENV_ASSIST)!({} as never, { action: 'act', payload });
    const request = { noticeId: notice.id, actionKind: notice.action!.kind, payload: notice.action!.payload };
    expect(await invoke(request)).toMatchObject({ success: true, data: { status: 'opened' } });
    expect(opener).toHaveBeenCalledExactlyOnceWith('automation');
    for (const forged of [{ ...request, noticeId: 'forged' }, { ...request, actionKind: 'request_grant' }, { ...request, payload: { pane: 'accessibility' } }, { ...request, payload: { pane: 'automation', url: 'https://invalid.test' } }]) {
      expect(await invoke(forged)).toMatchObject({ success: true, data: { status: 'rejected' } });
    }
    expect(opener).toHaveBeenCalledTimes(1);
    registerEnvAssistHandlers({ available: () => false, open: opener, findNotice: async () => notice as EnvAssistNotice });
    expect(await invoke(request)).toMatchObject({ data: { status: 'not_available' } });
    expect(opener).toHaveBeenCalledTimes(1);
  });
});
