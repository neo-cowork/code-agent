// 委派任务 Bash 步骤的「未执行」落标：生产事件序 task_progress(prepare) → tool_call_start → tool_call_end，
// 真实 ToolExecutionEngine + 真实 RunFinalizer + 真实 SessionCommandCenter 事件处理器，只替换最底层 toolExecutor.execute。
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ToolCall, ToolResult } from '../../../src/shared/contract';
import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { AntiPatternDetector } from '../../../src/host/agent/antiPattern/detector';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { SessionCommandCenter } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { getBackgroundTaskLedger, resetBackgroundTaskLedgerForTest } from '../../../src/host/task/backgroundTaskLedger';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import type { TaskManager } from '../../../src/host/task/TaskManager';
import { permissionDenialError } from '../../../src/host/tools/toolPermissionClassification';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';

vi.mock('../../../src/host/services', () => ({
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  getSessionManager: vi.fn(),
  getLangfuseService: () => ({ startNestedSpan: vi.fn(), endSpan: vi.fn() }),
  BudgetAlertLevel: {},
}));

vi.mock('../../../src/host/services/citation/citationService', () => ({
  getCitationService: () => ({ extractAndStore: vi.fn().mockReturnValue([]) }),
}));

vi.mock('../../../src/host/services/git/fileWatcherService', () => ({
  getFileWatcherService: () => ({
    getRecentExternalChanges: vi.fn().mockReturnValue([]),
    markAsAgentModified: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getGitStatusService: () => ({ onPostToolUse: vi.fn() }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getToolAnnotationsMap: () => mcpAnnotations.map,
    getToolDefinitions: () => [],
  }),
}));

const ROOT = '/tmp/toolres-k2';

const mcpAnnotations = vi.hoisted(() => ({
  map: new Map<string, MCPToolAnnotations>(),
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  getSessionManager: vi.fn(),
  getLangfuseService: () => ({ startNestedSpan: vi.fn(), endSpan: vi.fn() }),
  BudgetAlertLevel: {},
}));

vi.mock('../../../src/host/services/citation/citationService', () => ({
  getCitationService: () => ({ extractAndStore: vi.fn().mockReturnValue([]) }),
}));

vi.mock('../../../src/host/services/git/fileWatcherService', () => ({
  getFileWatcherService: () => ({
    getRecentExternalChanges: vi.fn().mockReturnValue([]),
    markAsAgentModified: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getGitStatusService: () => ({ onPostToolUse: vi.fn() }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getToolAnnotationsMap: () => mcpAnnotations.map,
    getToolDefinitions: () => [],
  }),
}));

function makeRuntimeContext(execute: RuntimeContext['toolExecutor']['execute'], onEvent: (event: AgentEvent) => void): RuntimeContext {
  return {
    systemPrompt: '',
    modelConfig: { provider: 'openai', model: 'gpt-test' } as never,
    toolExecutor: { execute } as never,
    messages: [],
    onEvent: (event) => onEvent(event),
    modelRouter: {} as never,
    maxIterations: 10,
    workingDirectory: ROOT,
    isDefaultWorkingDirectory: false,
    sessionId: 'session-a',
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
    control: ControlState.forTest({} as never),
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


const PROJECT_SCOPE = createWorkspaceScope('project-session-a', [{
  sourceId: 'source-session-a',
  path: '/tmp/session-a-project',
  role: 'primary',
  access: 'read_write',
}]);

class FakeTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockResolvedValue(undefined);
  private readonly observers = new Set<(sessionId: string, event: AgentEvent, taskId?: string) => void>();
  observeAgentEvents(observer: (sessionId: string, event: AgentEvent, taskId?: string) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }
  emitAgent(sessionId: string, event: AgentEvent, taskId?: string): void {
    this.observers.forEach((observer) => observer(sessionId, event, taskId));
  }
}

/** 生产形状的用户拒绝结果（toolExecutor ask-denied 分支）。 */
function userDenied(): Omit<ToolResult, 'toolCallId'> {
  const hostReason = permissionDenialError('Bash', 'user');
  return { success: false, error: hostReason.modelText, metadata: { failureCode: AgentFailureCode.PermissionDenied, hostReason } };
}

type Outcome = 'ran' | 'denied';

async function setup(outcomes: Record<string, Outcome>, afterExecute?: (id: string, ctx: RuntimeContext) => void) {
  const manager = new FakeTaskManager();
  const center = new SessionCommandCenter(manager as unknown as TaskManager, { projectTerminalResult: vi.fn() });
  const spawned = await center.spawn({
    sessionId: 'session-a', title: '整理下载文件夹', shortName: '整理', laneKey: 'lane-1',
    submissionKey: 'submission-1', prompt: '整理一下下载文件夹', workspaceScope: PROJECT_SCOPE,
  });
  if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');
  const taskId = spawned.task.id;
  const events: string[] = [];
  const ctx = makeRuntimeContext(async (_name, args, options) => {
    const id = String((options as { currentToolCallId?: string } | undefined)?.currentToolCallId ?? '');
    const outcome = outcomes[id] ?? 'ran';
    afterExecute?.(id, ctx);
    return outcome === 'denied'
      ? { toolCallId: id, ...userDenied() }
      : { toolCallId: id, success: true, output: `ran ${String(args.command)}` };
  }, (event) => {
    events.push(event.type === 'task_progress' || event.type === 'tool_call_start' || event.type === 'tool_call_end'
      ? `${event.type}:${(event.data as { toolCallId?: string; id?: string }).toolCallId ?? (event.data as { id?: string }).id}` : event.type);
    manager.emitAgent('session-a', event, taskId);
  });
  const engine = new ToolExecutionEngine(ctx);
  engine.setModules(
    { injectSystemMessage: vi.fn(), pushPersistentSystemContext: vi.fn(), getCurrentAttachments: vi.fn().mockReturnValue([]) } as never,
    new RunFinalizer(ctx),
    { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false) } as never,
  );
  const steps = () => getBackgroundTaskLedger().listTasks({ sessionId: 'session-a' }).find((task) => task.id === taskId)?.progress?.bashSteps ?? [];
  const lastStep = () => getBackgroundTaskLedger().listTasks({ sessionId: 'session-a' }).find((task) => task.id === taskId)?.progress?.lastToolStep;
  return { ctx, engine, events, steps, lastStep, center };
}

const bash = (id: string, command: string, description?: string): ToolCall => ({
  id, name: 'Bash', arguments: { command, ...(description ? { description } : {}) },
});

/** 每个夹具都必须是 prepare→start→end 的生产序：同一 callId 的三个事件里 progress 在 start 前。 */
function assertProductionOrder(events: string[], id: string) {
  const at = (prefix: string) => events.indexOf(`${prefix}:${id}`);
  expect(at('task_progress'), `${id} progress`).toBeGreaterThanOrEqual(0);
  expect(at('task_progress')).toBeLessThan(at('tool_call_start'));
  expect(at('tool_call_start')).toBeLessThan(at('tool_call_end'));
}

describe('delegated Bash step notRun is keyed by tool call id (production event order)', () => {
  beforeEach(() => {
    getProtocolRegistry();
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
  });

  it('(a) marks only the user-denied step among three commands', async () => {
    const { engine, events, steps, lastStep, center } = await setup({ c2: 'denied' });
    await engine.executeToolsWithHooks([bash('c1', 'ls ~/Downloads', '看看下载文件夹里有什么')]);
    await engine.executeToolsWithHooks([bash('c2', 'mkdir ~/Downloads/PDF', '新建 PDF 文件夹')]);
    await engine.executeToolsWithHooks([bash('c3', 'mv ~/Downloads/*.pdf ~/Downloads/PDF/', '把 PDF 移进去')]);
    ['c1', 'c2', 'c3'].forEach((id) => assertProductionOrder(events, id));
    expect(steps().map((s) => [s.callId, s.notRun ?? false])).toEqual([['c1', false], ['c2', true], ['c3', false]]);
    expect(lastStep()).toMatchObject({ callId: 'c3' });
    expect(lastStep()?.notRun).toBeUndefined();
    center.dispose();
  });

  it('(a2) latest step denied: lastToolStep carries notRun too', async () => {
    const { engine, steps, lastStep, center } = await setup({ c2: 'denied' });
    await engine.executeToolsWithHooks([bash('c1', 'ls', '看看')]);
    await engine.executeToolsWithHooks([bash('c2', 'rm -rf x', '删除')]);
    expect(lastStep()).toMatchObject({ callId: 'c2', notRun: true });
    expect(steps().map((s) => s.notRun ?? false)).toEqual([false, true]);
    center.dispose();
  });

  it('(b) denied then retried identical command that ran: only the denied one stays notRun', async () => {
    const { engine, events, steps, center } = await setup({ c1: 'denied' });
    await engine.executeToolsWithHooks([bash('c1', 'ls ~/Downloads', '看看下载文件夹')]);
    await engine.executeToolsWithHooks([bash('c2', 'ls ~/Downloads', '看看下载文件夹')]);
    ['c1', 'c2'].forEach((id) => assertProductionOrder(events, id));
    expect(steps().map((s) => [s.callId, s.notRun ?? false])).toEqual([['c1', true], ['c2', false]]);
    center.dispose();
  });

  it('(c) denied `ls ~/secret` then ran `ls`: the ls step is plain', async () => {
    const { engine, steps, center } = await setup({ c1: 'denied' });
    await engine.executeToolsWithHooks([bash('c1', 'ls ~/secret', '看看私密目录')]);
    await engine.executeToolsWithHooks([bash('c2', 'ls', '看看当前目录')]);
    expect(steps().map((s) => [s.callId, s.notRun ?? false])).toEqual([['c1', true], ['c2', false]]);
    center.dispose();
  });

  it('(d) executed npm test is not marked when identical later calls are barrier-deferred or force-sealed', async () => {
    const executed: string[] = [];
    const { engine, events, steps, center } = await setup({}, (id, ctx) => {
      executed.push(id);
      if (id === 'c3') ctx.control.forceFinalResponse('test');
    });
    await engine.executeToolsWithHooks([bash('c1', 'npm test', '跑测试')]);
    // 屏障之后的同命令：deferred，不 prepare、不产生 progress，只有 start + skipped end。
    await engine.executeToolsWithHooks([
      { id: 'barrier', name: 'AskUserQuestion', arguments: { questions: [] } },
      bash('c2', 'npm test', '跑测试'),
    ]);
    expect(events).toContain('tool_call_start:c2');
    expect(events).not.toContain('task_progress:c2');
    // c3 真跑并置位强制收尾，同批 c4（同命令）走 forceFinalSeal：start + skipped result，不派发。
    await engine.executeToolsWithHooks([bash('c3', 'npm test', '跑测试'), bash('c4', 'npm test', '跑测试')]);
    expect(executed).not.toContain('c4');
    expect(events).toContain('tool_call_end:c4');
    const byId = Object.fromEntries(steps().map((s) => [s.callId, s.notRun ?? false]));
    expect(byId.c1).toBe(false);
    expect(byId.c3).toBe(false);
    expect('c2' in byId).toBe(false);
    expect(byId.c4).toBe(true);
    ['c1', 'c3', 'c4'].forEach((id) => assertProductionOrder(events, id));
    center.dispose();
  });

  it('(e) parallel batch: several prepares precede any start, each step is marked by its own id', async () => {
    const { engine, events, steps, center } = await setup({ p2: 'denied', p4: 'denied' });
    await engine.executeToolsWithHooks([
      { id: 'p1', name: 'Read', arguments: { file_path: 'a.txt' } },
      { id: 'p2', name: 'Bash', arguments: { command: 'ls a', description: 'A' } },
      { id: 'p3', name: 'Bash', arguments: { command: 'ls b', description: 'B' } },
      { id: 'p4', name: 'Bash', arguments: { command: 'ls c', description: 'C' } },
    ]);
    ['p2', 'p3', 'p4'].forEach((id) => assertProductionOrder(events, id));
    expect(Object.fromEntries(steps().map((s) => [s.callId, s.notRun ?? false]))).toEqual({ p2: true, p3: false, p4: true });
    center.dispose();
  });
});
