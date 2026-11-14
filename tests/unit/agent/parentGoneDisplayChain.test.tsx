// @vitest-environment jsdom
import { emitCommandCenterToolStart, applyCommandCenterPreannounce } from '../../../src/host/agent/runtime/contextAssembly/sessionCommandCenterPreannounce';
// Real host producers -> registry completion -> agent tree -> both display surfaces.
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';

const mocks = vi.hoisted(() => {
  const responses: Array<Record<string, unknown>> = [];
  const seen: string[] = [];
  const inference = vi.fn(async (messages: unknown) => {
    seen.push(JSON.stringify(messages));
    const response = responses.shift();
    if (!response) throw new Error('Missing mocked inference response');
    return response;
  });
  const installDefaultInference = () => {
    inference.mockReset();
    inference.mockImplementation(async (messages: unknown) => {
      seen.push(JSON.stringify(messages));
      const response = responses.shift();
      if (!response) throw new Error('Missing mocked inference response');
      return response;
    });
  };
  let cancellationController: AbortController | undefined;
  const pipelineContext = {
    agentId: 'pipeline-agent',
    permissionConfig: { blockedCommands: [] as string[] },
  };
  const pipeline = {
    createContext: vi.fn(() => pipelineContext),
    checkBudget: vi.fn(() => ({ allowed: true, warnings: [] as string[] })),
    checkToolExecution: vi.fn(() => ({ allowed: true })),
    completeContext: vi.fn(),
    getBudgetStatus: vi.fn(() => ({ subagentCost: 0 })),
    getRemainingBudget: vi.fn(() => undefined),
    recordTokenUsage: vi.fn(),
    recordToolUsage: vi.fn(),
  };
  return {
    responses,
    seen,
    inference,
    installDefaultInference,
    pipeline,
    pipelineContext,
    setCancellationController: (controller: AbortController) => { cancellationController = controller; },
    getCancellationController: () => cancellationController,
  };
});

vi.mock('../../../src/host/services/infra/logger', () => ({
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
  createLogger: () => ({ info: vi.fn(), warn: (...args: unknown[]) => { process.stderr.write(`${args.map(String).join(' ')}\n`); }, error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: (...args: unknown[]) => { process.stderr.write(`${args.map(String).join(' ')}\n`); }, error: vi.fn(), debug: vi.fn(), dispose: vi.fn() },
}));

vi.mock('../../../src/host/model/modelRouter', () => ({
  ModelRouter: class { inference = mocks.inference; },
  PROVIDER_REGISTRY: { test: { models: [{ id: 'test-model', supportsTool: true }] } },
}));

vi.mock('../../../src/host/model/adapters/aiSdkAdapter', () => ({
  aiSdkSupportsProvider: () => false,
  inferenceViaAiSdk: vi.fn(),
}));

vi.mock('../../../src/host/agent/subagentPipeline', () => ({
  getSubagentPipeline: () => mocks.pipeline,
}));

vi.mock('../../../src/host/agent/subagentToolRuntime', () => ({
  createSubagentToolRuntime: () => ({ executor: { execute: vi.fn() }, policy: {} }),
}));

vi.mock('../../../src/host/agent/agentTask', () => ({
  AgentTask: class {
    id: string;
    appendTranscript = vi.fn();
    stop = vi.fn();
    fail = vi.fn();
    constructor(id: string) { this.id = id; }
  },
}));

vi.mock('../../../src/host/agent/subagentLifecycleHooks', () => ({
  startSubagentLifecycle: ({ context }: { context: { sessionId: string } }) => context.sessionId,
}));

vi.mock('../../../src/host/agent/subagentExecutionTracing', () => ({
  runSubagentExecutionWithTrace: (_request: unknown, run: () => Promise<unknown>) => run(),
}));

vi.mock('../../../src/host/agent/subagentExecutionRouter', () => ({
  routeExternalSubagentExecution: () => null,
}));

vi.mock('../../../src/host/agent/subagentFirstRunPreset', () => ({
  resolveSubagentPreset: async (preset: unknown) => preset,
}));

vi.mock('../../../src/host/agent/subagentProtocolContext', () => ({
  normalizeSubagentModelContext: (context: unknown) => context,
  resolveSubagentParentContext: () => ({ availableTools: [] }),
}));

vi.mock('../../../src/host/agent/childContext', () => ({
  buildChildContext: (child: { allowedTools: string[] }) => ({
    toolPool: child.allowedTools,
    permissions: { deny: [], blockedCommands: [], effectiveMode: 'default' },
  }),
}));

vi.mock('../../../src/host/agent/subagentExecutorCancellation', () => ({
  getChildSubagentExecutionTimeout: () => 60_000,
  getSubagentIdleTimeout: () => 30_000,
  flushSubagentCancellation: vi.fn(async () => {}),
  createSubagentCancellationLifecycle: () => {
    const controller = new AbortController();
    mocks.setCancellationController(controller);
    return {
      effectiveController: controller,
      effectiveSignal: controller.signal,
      cleanupTimer: vi.fn(),
      markProgress: vi.fn(),
      markRequestStart: vi.fn(),
      markRequestEnd: vi.fn(),
      markToolStart: vi.fn(),
      markToolEnd: vi.fn(),
      stopIdleWatchdog: vi.fn(),
    };
  },
}));

vi.mock('../../../src/host/platform/appPaths', () => ({
  getUserDataPath: () => '/tmp',
  getPath: () => '/tmp',
}));

vi.mock('../../../src/host/services/checkpoint/taskPatchService', () => ({
  captureWorkspacePatch: vi.fn(async () => undefined),
}));

vi.mock('../../../src/host/context/subagentContextStore', () => ({
  getSubagentContextStore: () => ({ upsert: vi.fn(), list: () => [] }),
}));

vi.mock('../../../src/host/context/contextInterventionState', () => ({
  getContextInterventionState: () => ({ getEffectiveSnapshot: () => ({}) }),
}));

vi.mock('../../../src/host/context/contextInterventionHelpers', () => ({
  applyInterventionsToMessages: (messages: unknown) => messages,
}));

vi.mock('../../../src/host/agent/subagentCompaction', () => ({
  compactSubagentMessages: () => false,
}));

vi.mock('../../../src/host/telemetry/telemetryCollector', () => ({
  getTelemetryCollector: () => ({ recordDetachedTurn: vi.fn() }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({ permissions: { inheritance: 'strict-inherit' } }),
  }),
}));

vi.mock('../../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: () => [],
  adoptOrphanTasks: vi.fn(),
}));

vi.mock('../../../src/host/services/roleAssets', () => ({
  buildRoleContextBlock: vi.fn(),
  runRoleWriteBack: vi.fn(async () => {}),
  recordRoleParticipation: vi.fn(),
  applyRoleBoundaryToSubagentRequest: vi.fn((request: unknown) => request),
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';
import { BackgroundSubagentRegistry, getBackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { buildAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';
import { BackgroundSubagentDurableLedger, configureBackgroundSubagentDurableLedger } from '../../../src/host/agent/backgroundSubagentDurableLedger';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';
import { createBackgroundSubagentRecoveryHandler } from '../../../src/host/runtime/durableRecoveryHandlers';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import type { AgentTreeSnapshot } from '../../../src/shared/contract/agentTree';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { ToolCall } from '../../../src/shared/contract';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { DelegationHeader, DelegationReceipt } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/DelegationReceipt';
import { deriveDelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';
import { SessionAgentsPanel } from '../../../src/renderer/components/TaskPanel/SessionAgentsPanel';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';

import type { TraceNode } from '../../../src/shared/contract/trace';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { buildAgentRows } from '../../../src/renderer/utils/agentRows';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { humanizeToolGroupLabel } from '../../../src/renderer/utils/humanizeToolStep';

let language: 'zh' | 'en' = 'en';
const invokeDomain = vi.fn();
const invoke = vi.fn<(_channel: string) => Promise<unknown>>(async () => []);
const appState = {
  get language() { return language; },
  setWorkbenchCollapsed: vi.fn(),
  pendingPermissionRequest: null,
  pendingPermissionSessionId: null,
  queuedPermissionRequests: {},
  activeAgentId: null,
  processingSessionIds: new Set<string>(),
  resolvedPermissionRequests: {},
};
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: language === 'zh' ? zh : en }) }));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign((selector: (state: typeof appState) => unknown) => selector(appState), { getState: () => appState }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: {
  invoke: (...args: [string]) => invoke(...args),
  invokeDomain: (...args: unknown[]) => invokeDomain(...args),
} }));
vi.mock('../../../src/host/agent/backgroundSubagentIdleWake', () => ({ scheduleBackgroundSubagentIdleWake: vi.fn() }));

function printEvidence(line: string) { process.stdout.write(`${line}\n`); }

const sessionId = 'session-parent-gone-display';
const title = 'Compare three note-taking apps';
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;

// Literal byte baselines from origin/main; do not derive the expectation from the active dictionary.
const chineseCard = '执行失败助手上级任务已经结束';
const chinesePanelRow = '助手失败：上级任务已经结束';

async function assertSurfaces(snapshot: AgentTreeSnapshot, producer: string) {
  expect(snapshot.nodes).toHaveLength(1);
  const node = snapshot.nodes[0];
  expect(node.failureCode).toBe(AgentFailureCode.ParentGone);
  expect(node.status).toBe('failed');
  expect(node.sources).toContain('backgroundRegistry');
  printEvidence(`${producer} node=${JSON.stringify(node)}`);
  const call: ToolCall = {
    id: 'spawn-notes', name: 'spawn_agent', arguments: { task: title, run_in_background: true },
    result: { toolCallId: 'spawn-notes', success: true, metadata: { agentId: node.backgroundAgentId } },
  };
  for (const locale of ['en', 'zh'] as const) {
    language = locale;
    const presentation = deriveDelegationPresentation(call, [], snapshot.nodes, locale === 'en' ? en : zh);
    expect(presentation).not.toBeNull();
    const card = render(<><DelegationHeader presentation={presentation!} /><DelegationReceipt presentation={presentation!} /></>);
    const cardText = card.container.textContent;
    printEvidence(`${producer} ${locale} chat textContent=${JSON.stringify(cardText)}`);
    if (locale === 'en') {
      expect(cardText).toContain("Background assistant didn't finish");
      expect(cardText).toContain('The parent task has already ended');
      expect(cardText).not.toMatch(cjk);
      expect(cardText).not.toContain('Not completed background');
    } else {
      expect(cardText).toBe(chineseCard);
    }
    card.unmount();
    // Only the IPC boundary is stubbed. SessionAgentsPanel runs the real useSessionAgentRows.
    invokeDomain.mockImplementation(async (domain, action) => domain === IPC_DOMAINS.AGENT && action === 'getTree' ? snapshot : null);
    const panel = render(<SessionAgentsPanel />);
    const row = await screen.findByTestId(`agents-panel-row-${node.id}`);
    const panelText = screen.getByTestId('session-agents-panel').textContent;
    printEvidence(`${producer} ${locale} panel textContent=${JSON.stringify(panelText)}`);
    if (locale === 'en') {
      expect(row.textContent).toContain('Background assistant');
      expect(row.textContent).toContain('The parent task has already ended');
      expect(row.textContent).toContain(en.expert.memberBar.panel.status.failed);
      expect(panelText).not.toMatch(cjk);
      expect(panelText).not.toContain('Not completed background');
    } else {
      expect(row.textContent).toBe(chinesePanelRow);
    }
    panel.unmount();
  }
}

beforeEach(() => {
  configureBackgroundSubagentDurableLedger.resetForTest();
  mocks.installDefaultInference();
  mocks.seen.length = 0;
  mocks.responses.length = 0;
  process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  useSwarmStore.setState({ activeSessionId: undefined, activeRunId: undefined, activeTreeId: undefined, lastEventAt: undefined, eventLog: [], agents: [] });
  useSessionStore.setState({ sessions: [], currentSessionId: sessionId });
  useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
  useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
  useAgentRegistryStore.setState({ entries: [], isLoaded: true });
  useMemberViewStore.setState({ viewingMemberId: null });
  useVoiceCallStore.getState().reset();
  useBackgroundTaskStore.setState({ tasks: [] });
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  invokeDomain.mockReset();
  (window as unknown as { domainAPI?: unknown }).domainAPI = undefined;
});
afterEach(() => {
  cleanup();
  configureBackgroundSubagentDurableLedger.resetForTest();
  delete process.env.CODE_AGENT_MODEL_ENGINE;
});

describe('parent-gone production-to-display chain', () => {
  it('Producer A: real execute reaps a detached child after its first iteration, then renders EN and unchanged ZH', async () => {
    const registry = new BackgroundSubagentRegistry();
    const isParentAlive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    mocks.responses.push({ type: 'tool_use', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });
    const agentId = registry.spawn(() => new SubagentExecutor().execute({
      prompt: title,
      config: { name: 'Background assistant', systemPrompt: 'Compare the apps.', availableTools: [], maxIterations: 4 },
      context: {
        sessionId, cwd: '/tmp/parent-gone-display',
        modelConfig: { provider: 'test', model: 'test-model' },
        resolver: { getDefinition: () => undefined },
        permission: { request: vi.fn(async () => true) },
        events: { emit: vi.fn(), detached: true },
        abortSignal: new AbortController().signal,
        isParentAlive,
      },
    }), { sessionId, runId: 'parent-run-A', title });
    const result = await registry.await(agentId);
    expect(isParentAlive).toHaveBeenCalledTimes(2);
    expect(mocks.inference).toHaveBeenCalledTimes(1);
    expect(mocks.getCancellationController()?.signal.reason).toBe('parent-gone');
    expect(result).toMatchObject({ success: false, cancellationReason: 'parent-gone', failureCode: AgentFailureCode.ParentGone, iterations: 2 });
    printEvidence(`Producer A asserted failureCode=${result!.failureCode} abortReason=${mocks.getCancellationController()?.signal.reason} result=${JSON.stringify(result)}`);
    await assertSurfaces(buildAgentTreeSnapshot({ sessionId, backgroundAgents: registry.list() }), 'Producer A');
  });

  it('Producer B: real recovery terminalizes a durable child and renders EN and unchanged ZH', async () => {
    const db = new Database(':memory:');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    const kernel = new DurableRunKernel({ stores: repository, ownerId: 'native-host', processInstanceId: 'before-crash', leaseDurationMs: 60_000 });
    const ledger = new BackgroundSubagentDurableLedger(kernel);
    configureBackgroundSubagentDurableLedger(ledger);
    const beforeCrash = new BackgroundSubagentRegistry();
    let finish!: (result: SubagentResult) => void;
    const pending = new Promise<SubagentResult>((resolve) => { finish = resolve; });
    const agentId = beforeCrash.spawn(() => pending, { sessionId, runId: 'parent-run-B', title });
    try {
      await vi.waitFor(async () => expect(await repository.get(agentId)).not.toBeNull());
      const restartedKernel = new DurableRunKernel({ stores: repository, ownerId: 'native-host', processInstanceId: 'after-crash', leaseDurationMs: 60_000 });
      const registry = new RunRegistry();
      registry.configureDurableKernel(restartedKernel);
      const now = Date.now() + 120_000;
      const plans = await registry.recoverDurable(now);
      expect(plans).toHaveLength(1);
      const outcome = await createBackgroundSubagentRecoveryHandler({ registry }).recover(plans[0], now);
      expect(outcome).toMatchObject({ status: 'recovered', reason: 'interrupted_by_restart' });
      const closed = await repository.get(agentId);
      expect(closed).toMatchObject({ status: 'failed', terminal: { reason: 'interrupted_by_restart' } });
      const recovered = getBackgroundSubagentRegistry();
      const [record] = recovered.drainCompletionNotifications({ sessionId });
      expect(record.failureCode).toBe(AgentFailureCode.ParentGone);
      expect(record.content).toContain('interrupted_by_restart');
      printEvidence(`Producer B asserted failureCode=${record.failureCode} reason=${closed!.terminal!.reason} completion=${JSON.stringify(record)}`);
      const snapshot = buildAgentTreeSnapshot({ sessionId, backgroundAgents: recovered.listBySession(sessionId) });
      await assertSurfaces(snapshot, 'Producer B');
      await assertRestartDisplay(snapshot);
    } finally {
      // Release the simulated pre-crash execution and its heartbeat before closing SQLite.
      finish({ success: true, output: 'cleanup', toolsUsed: [], iterations: 0 });
      await beforeCrash.await(agentId);
      db.close();
    }
  });
});


async function assertRestartDisplay(snapshot: AgentTreeSnapshot) {
  const node = snapshot.nodes[0];
  // Persisted spawn placeholder from the real crash run: no fabricated result agentId.
  const interrupted: ToolCall = {
    id: 'spawn-crashed', name: 'spawn_agent', arguments: { task: node.task, role: 'coder', run_in_background: true },
    result: { toolCallId: 'spawn-crashed', success: false,
      error: 'interrupted: process crashed before a result was recorded; do not assume it ran or succeeded', duration: 0 },
  };
  for (const locale of ['en', 'zh'] as const) {
    language = locale;
    invokeDomain.mockImplementation(async (domain, action) => domain === IPC_DOMAINS.AGENT && action === 'getTree' ? snapshot : null);
    const realShortName = 'Compare three note-taking apps';
    const mainZhWakeNote = `后台任务「${realShortName}」已结束；自动汇报这一步没能完成，恢复原账号登录后可查看任务结果，也可以直接问我。`;
    const notice = render(<TraceNodeRenderer sessionId={sessionId} node={{
      id: 'recovered-wake-note', type: 'system', timestamp: 1,
      content: mainZhWakeNote,
      metadata: { backgroundWakeFailed: { taskId: 'session-work-crashed-task', reason: 'wake_failed', title: realShortName } },
    }} />);
    if (locale === 'en') {
      expect(notice.container.textContent).toContain(realShortName);
      expect(notice.container.textContent).toContain('sign back in to the original account to view the task result');
      expect(notice.container.textContent).not.toMatch(cjk);
    } else {
      expect(notice.container.textContent).toBe(mainZhWakeNote);
      expect(notice.container.textContent).toContain('恢复原账号登录后可查看任务结果');
    }
    printEvidence(`r3 ${locale} recovered notice=${JSON.stringify(notice.container.textContent)}`);
    notice.unmount();
    const presentation = deriveDelegationPresentation(interrupted, [], snapshot.nodes, locale === 'en' ? en : zh);
    expect.soft(presentation, `${locale} interrupted spawn must correlate its real recovered node`).not.toBeNull();
    expect.soft(presentation).toEqual(deriveDelegationPresentation({ ...interrupted,
      result: { ...interrupted.result!, metadata: { agentId: node.backgroundAgentId } },
    }, [], snapshot.nodes, locale === 'en' ? en : zh));
    const card = render(<ToolCallDisplay toolCall={interrupted} index={0} total={1} />);
    await waitFor(() => expect(card.container.textContent).toContain(locale === 'en'
      ? "Background assistant didn't finish" : '执行失败助手')).catch(() => undefined);
    expect.soft(card.container.textContent).toContain(locale === 'en' ? "Background assistant didn't finish" : '执行失败助手');
    printEvidence(`r2 ${locale} restarted card textContent=${JSON.stringify(card.container.textContent)}`);
    expect.soft(card.container.textContent).toContain(locale === 'en' ? 'The parent task has already ended' : '上级任务已经结束');
    if (locale === 'en') expect(card.container.textContent).not.toMatch(cjk);
    card.unmount();
    // A real restart has a durable trace member AND a node. Exercise the merged row,
    // resolving raw role ids in both locales through agentRoleLabels.
    for (const duration of [38_000, 65_000]) {
      const run = { id: 'trace-r2', sessionId, status: 'failed', coordinator: 'parallel', startedAt: 1000,
        endedAt: 1000 + duration, durationMs: duration, totalAgents: 1, completedCount: 0, failedCount: 1,
        totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, trigger: 'llm-spawn' };
      invoke.mockImplementation(async (channel) => channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS ? [run]
        : channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL ? { run: { ...run, totalToolCalls: 0 }, events: [], agents: [{
          runId: run.id, agentId: node.id, name: 'coder', role: 'coder', status: 'failed', startTime: 1000,
          endTime: 1000 + duration, durationMs: duration, tokensIn: 0, tokensOut: 0, toolCalls: 0, costUsd: 0,
          error: null, failureCategory: null, filesChanged: [],
        }] } : []);
      const panel = render(<SessionAgentsPanel />);
      const footer = await screen.findByTestId('agents-panel-usage');
      const text = screen.getByTestId('session-agents-panel').textContent;
      printEvidence(`r2 ${locale} duration=${duration} panel textContent=${JSON.stringify(text)}`);
      expect.soft(footer.textContent).toBe(locale === 'en'
        ? duration === 38_000 ? '38s' : '1m 5s'
        : duration === 38_000 ? '38 秒' : '1 分 5 秒');
      if (locale === 'en') {
        expect.soft(text).toContain('Background assistant');
        expect.soft(text).not.toContain('coder');
        expect.soft(text).not.toMatch(cjk);
      } else {
        expect.soft(text).not.toContain('coder');
        expect.soft(screen.getByTestId(`agents-panel-row-${node.id}`).textContent).toBe('编编程员失败：上级任务已经结束');
      }
      panel.unmount();
    }
    invoke.mockResolvedValue([]);
  }
  language = 'en';
  // No association is invented when the spawn failed for another reason or task.
  expect(deriveDelegationPresentation({ ...interrupted, arguments: { ...interrupted.arguments, task: 'Other task' } }, [], snapshot.nodes, en)).toBeNull();
  expect(deriveDelegationPresentation({ ...interrupted, result: { ...interrupted.result!, error: 'Permission denied' } }, [], snapshot.nodes, en)).toBeNull();
  expect(deriveDelegationPresentation(interrupted, [], [...snapshot.nodes, ...snapshot.nodes], en)).toBeNull();
  expect(deriveDelegationPresentation({ ...interrupted, result: { ...interrupted.result!,
    error: 'interrupted: tool call was cancelled before a result was recorded',
  } }, [], snapshot.nodes, en)).toBeNull();
}

describe('r2 complete group summary', () => {
  it.each(['en', 'zh'] as const)('uses %s punctuation and number forms across the whole group line', (locale) => {
    language = locale;
    const nodes: TraceNode[] = ['unrecognized-step', 'spawn_agent'].map((name, index) => ({
      id: `group-${index}`, type: 'tool_call', content: '', timestamp: index,
      toolCall: { id: `call-group-${index}`, name, args: {}, result: 'interrupted: process crashed before a result was recorded', success: false },
    }));
    const group = render(<ToolStepGroup nodes={nodes} sessionId={sessionId} />);
    const line = screen.getByTestId('tool-group-head-label').textContent;
    printEvidence(`r2 ${locale} group textContent=${JSON.stringify(line)}`);
    expect(line).toBe(locale === 'en' ? 'Could not run 1 step, Could not dispatch 1 agent task' : '执行 1 个步骤未成功、派发 1 次代理任务未成功');
    if (locale === 'en') expect(line).not.toMatch(cjk);
    group.unmount();
    const t = locale === 'en' ? en : zh;
    const plural = humanizeToolGroupLabel(['unrecognized-step', 'another-step', 'spawn_agent', 'spawn_agent'], t, 'failed');
    expect(plural).toBe(locale === 'en' ? 'Could not run 2 steps, Could not dispatch 2 agent tasks' : '执行 2 个步骤未成功、派发 2 次代理任务未成功');
  });
});


it.each(['en', 'zh'] as const)('resolves raw known and unknown member role names through the %s display dictionary', (locale) => {
  language = locale;
  const rows = buildAgentRows({
    members: ['coder', 'unregistered-role'].map((roleId) => ({ key: roleId, roleId, name: roleId, status: 'failed', isLead: false })),
    nodes: [], tasks: [],
  });
  expect(rows.map((row) => row.name)).toEqual(locale === 'en' ? ['Coder', 'Assistant'] : ['编程员', '助手']);
});

it.each(['en', 'zh'] as const)('localizes the real SessionCommandTask wake failure notice in %s with title and main ZH copy', async (locale) => {
  language = locale;
  invokeDomain.mockResolvedValue({
    nodes: [{
      id: 'unrelated-agent-node', role: 'coder', task: 'You are a research-and-writing assistant.',
      status: 'failed', statusLabel: '失败', background: true,
      children: [], worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [], sources: ['backgroundRegistry'],
    }],
  });
  const shortName = 'Compare three note-taking apps';
  const mainZhSentence = `后台任务「${shortName}」已结束；自动汇报这一步没能完成，恢复原账号登录后可查看任务结果，也可以直接问我。`;
  const notice: TraceNode = {
    id: 'wake-failure', type: 'system', timestamp: 1,
    content: mainZhSentence,
    metadata: { backgroundWakeFailed: { taskId: 'session-work-not-in-tree', reason: 'wake_failed', title: shortName } },
  };
  const view = render(<TraceNodeRenderer node={notice} sessionId={sessionId} />);
  const expected = locale === 'en'
    ? `Background task "${shortName}" has ended; the automatic report could not be completed — sign back in to the original account to view the task result, or ask me directly.`
    : mainZhSentence;
  await waitFor(() => expect(view.container.textContent).toBe(expected));
  printEvidence(`r3 ${locale} notice textContent=${JSON.stringify(view.container.textContent)}`);
  if (locale === 'en') {
    expect(view.container.textContent).toContain(shortName);
    expect(view.container.textContent).toContain('sign back in to the original account to view the task result');
    expect(view.container.textContent).not.toMatch(cjk);
  } else {
    expect(view.container.textContent).toContain('恢复原账号登录后可查看任务结果');
  }
  view.unmount();

  if (locale === 'en') {
    const legacy = render(<TraceNodeRenderer sessionId={sessionId} node={{
      id: 'wake-failure-legacy', type: 'system', timestamp: 2,
      content: '后台任务「You are a research-and-w…」已结束；自动汇报这一步没能完成，恢复原账号登录后可查看任务结果，也可以直接问我。',
      metadata: { backgroundWakeFailed: { taskId: 'unrelated-agent-node', reason: 'wake_failed' } },
    }} />);
    await waitFor(() => expect(legacy.container.textContent).toContain('Background assistant'));
    expect(legacy.container.textContent).not.toContain('You are a');
    expect(legacy.container.textContent).not.toMatch(cjk);
    legacy.unmount();

    const cjkTitle = render(<TraceNodeRenderer sessionId={sessionId} node={{
      id: 'wake-failure-cjk-title', type: 'system', timestamp: 3,
      content: '后台任务「周报」已结束；自动汇报这一步没能完成，恢复原账号登录后可查看任务结果，也可以直接问我。',
      metadata: { backgroundWakeFailed: { taskId: 'session-work-zh-title', reason: 'wake_failed', title: '周报' } },
    }} />);
    expect(cjkTitle.container.textContent).toContain('Background assistant');
    expect(cjkTitle.container.textContent).not.toMatch(cjk);
    cjkTitle.unmount();
  }
});

it.each(['en', 'zh'] as const)('localizes the persisted session-work restart notice in %s', (locale) => {
  language = locale;
  const view = render(<TraceNodeRenderer node={{ id: 'session-work-interrupted', type: 'system', timestamp: 1,
    content: '应用重启时这个后台任务还没做完，已被中断，结果没能送回这里。需要的话请重新发起。',
    metadata: { backgroundTaskInterrupted: { taskId: 'session-work-task' } },
  }} />);
  expect(view.container.textContent).toBe((locale === 'en' ? en : zh).backgroundPanel.interrupted);
  if (locale === 'en') expect(view.container.textContent).not.toMatch(cjk);
  printEvidence(`r3 ${locale} session-work notice=${JSON.stringify(view.container.textContent)}`);
});

it.each(['en', 'zh'] as const)('uses the session-work restart reason in card and panel in %s', (locale) => {
  language = locale;
  const task: Task = { id: 'session-work-test', kind: 'session_command_task', source: 'session_command_center',
    sessionId, title: 'Compare notes', status: 'failed', createdAt: 1, updatedAt: 2, events: [], outputRefs: [],
    toolCallId: 'delegate-test', failure: { reason: 'session_command_task_interrupted_by_restart', message: '应用重启时这个后台任务还没做完，已被中断，结果没能送回这里。需要的话请重新发起。' },
  };
  const t = locale === 'en' ? en : zh;
  const rows = buildAgentRows({ members: [], nodes: [], tasks: [task] });
  expect(rows[0].failureReason).toBe(t.backgroundPanel.interrupted);
  const presentation = deriveDelegationPresentation({ id: 'delegate-test', name: 'delegate_task', arguments: {}, result: { toolCallId: 'delegate-test', success: true, output: 'accepted' } }, [task], [], t);
  expect(presentation?.failure).toBe(t.backgroundPanel.interrupted);
  if (locale === 'en') expect(rows[0].failureReason).not.toMatch(cjk);
});

it.each(['en', 'zh'] as const)('associates recovered session-work by stable receipt id in %s', (locale) => {
  language = locale;
  const task: Task = { id: 'session-work-recovered', kind: 'session_command_task', source: 'session_command_center',
    sessionId, title: 'Compare notes', status: 'failed', createdAt: 1, updatedAt: 2, events: [], outputRefs: [],
    failure: { reason: 'session_command_task_interrupted_by_restart', message: '应用重启时这个后台任务还没做完，已被中断，结果没能送回这里。需要的话请重新发起。' },
  };
  const call: ToolCall = { id: 'delegate-without-persisted-link', name: 'delegate_task', arguments: {}, result: {
    toolCallId: 'delegate-without-persisted-link', success: true, output: 'accepted',
    metadata: { sessionTask: { outcome: 'accepted', tasks: [{ taskId: task.id, shortName: 'Note', status: 'running' }] } },
  } };
  const t = locale === 'en' ? en : zh;
  const presentation = deriveDelegationPresentation(call, [task], [], t);
  expect(presentation?.state).toBe('failed');
  expect(presentation?.failure).toBe(t.backgroundPanel.interrupted);
  const view = render(<><DelegationHeader presentation={presentation!} /><DelegationReceipt presentation={presentation!} /></>);
  expect(view.container.textContent).not.toContain(task.id);
  if (locale === 'en') expect(view.container.textContent).not.toMatch(cjk);
  printEvidence(`r4 ${locale} stable task card=${JSON.stringify(view.container.textContent)}`);
  expect(deriveDelegationPresentation({ ...call, result: { ...call.result!, metadata: undefined } }, [task], [], t)).toBeNull();
  expect(deriveDelegationPresentation(call, [{ ...task, id: 'different-task' }], [], t)).toBeNull();
});

it.each(['en', 'zh'] as const)('keeps generated preannounce metadata and localizes only its text in %s', async (locale) => {
  language = locale;
  const userMessage = 'Compare notes';
  const preview = emitCommandCenterToolStart({ toolName: 'delegate_task', locale, commandCenterEnabled: true,
    streamedContent: '', existingPreannounce: '', userMessage, emitPreview: () => {}, emitToolStart: () => {},
  });
  const response = applyCommandCenterPreannounce({ type: 'tool_use', content: 'Authored response', toolCalls: [] }, preview, userMessage);
  expect(response.backgroundTaskPreannounce).toEqual({ text: preview, title: userMessage });
  if (locale === 'en') expect(preview).not.toMatch(cjk);
  const view = render(<TraceNodeRenderer node={{ id: 'preannounce', type: 'assistant_text', timestamp: 1,
    content: preview, metadata: { backgroundTaskPreannounce: response.backgroundTaskPreannounce },
  }} />);
  await waitFor(() => expect(view.container.textContent).toContain(locale === 'en' ? 'in the background' : '交给后台执行'));
  printEvidence(`r4 ${locale} preannounce=${JSON.stringify(view.container.textContent)}`);
  if (locale === 'en') expect(view.container.textContent).not.toMatch(cjk);
  view.unmount();
  language = locale === 'en' ? 'zh' : 'en';
  const switched = render(<TraceNodeRenderer node={{ id: 'preannounce-switched', type: 'assistant_text', timestamp: 1,
    content: preview, metadata: { backgroundTaskPreannounce: response.backgroundTaskPreannounce },
  }} />);
  await waitFor(() => expect(switched.container.textContent).toContain(language === 'en' ? 'in the background' : '交给后台执行'));
  if (language === 'en') expect(switched.container.textContent).not.toMatch(cjk);
  switched.unmount();
  const authored = render(<TraceNodeRenderer node={{ id: 'authored', type: 'assistant_text', timestamp: 1,
    content: 'Authored response', metadata: { backgroundTaskPreannounce: response.backgroundTaskPreannounce },
  }} />);
  expect(authored.container.textContent).toContain('Authored response');
});

it('keeps the preannouncement marker off subsequent authored text, even identical text', () => {
  const text = 'host-generated preannouncement';
  const projection = projectTurns([{ id: 'user', role: 'user', content: 'Compare notes', timestamp: 1 }, {
    id: 'assistant', role: 'assistant', content: text + text, timestamp: 2,
    metadata: { backgroundTaskPreannounce: { text } },
    contentParts: [{ type: 'text', text }, { type: 'text', text }, { type: 'tool_call', toolCallId: 'delegate' }],
    toolCalls: [{ id: 'delegate', name: 'delegate_task', arguments: {} }],
  }], sessionId, false);
  const nodes = projection.turns.flatMap((turn) => turn.nodes).filter((node) => node.type === 'assistant_text');
  expect(nodes[0].metadata?.backgroundTaskPreannounce).toEqual({ text });
  expect(nodes[1].metadata?.backgroundTaskPreannounce).toBeUndefined();
  expect(nodes[1].content).toBe(text);
});

it.each(['en', 'zh'] as const)('shows the session-work model title safely in %s on both surfaces', (locale) => {
  language = locale;
  const task: Task = { id: 'session-work-integration', kind: 'session_command_task', source: 'session_command_center',
    sessionId, title: '对比 Apple Notes、Notion、Obsidian', status: 'failed', createdAt: 1, updatedAt: 2, events: [], outputRefs: [],
    failure: { reason: 'session_command_task_interrupted_by_restart', message: '应用重启时这个后台任务还没做完，已被中断，结果没能送回这里。需要的话请重新发起。' },
  };
  const call: ToolCall = { id: 'integration-call', name: 'delegate_task', arguments: {}, result: {
    toolCallId: 'integration-call', success: true, output: 'accepted',
    metadata: { sessionTask: { outcome: 'accepted', tasks: [{ taskId: task.id, shortName: '笔记', status: 'running' }] } },
  } };
  const t = locale === 'en' ? en : zh;
  const row = buildAgentRows({ members: [], nodes: [], tasks: [task] })[0];
  const presentation = deriveDelegationPresentation(call, [task], [], t);
  expect(row.name).toBe(locale === 'en' ? 'Background assistant' : task.title);
  expect(presentation?.title).toBe(row.name);
  const card = render(<><DelegationHeader presentation={presentation!} /><DelegationReceipt presentation={presentation!} /></>);
  if (locale === 'en') { expect(card.container.textContent).not.toMatch(cjk); expect(row.name).not.toMatch(cjk); }
  printEvidence(`integration ${locale} title card=${JSON.stringify(card.container.textContent)} row=${JSON.stringify(row.name)}`);
});
