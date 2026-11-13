// @vitest-environment jsdom
// Real host producers -> registry completion -> agent tree -> both display surfaces.
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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
import { IPC_DOMAINS } from '../../../src/shared/ipc';

let language: 'zh' | 'en' = 'en';
const invokeDomain = vi.fn();
const appState = {
  get language() { return language; },
  setWorkbenchCollapsed: vi.fn(),
  pendingPermissionRequest: null,
  pendingPermissionSessionId: null,
  queuedPermissionRequests: {},
  activeAgentId: null,
};
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: language === 'zh' ? zh : en }) }));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign((selector: (state: typeof appState) => unknown) => selector(appState), { getState: () => appState }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: {
  invoke: async () => [],
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
      await assertSurfaces(buildAgentTreeSnapshot({ sessionId, backgroundAgents: recovered.listBySession(sessionId) }), 'Producer B');
    } finally {
      // Release the simulated pre-crash execution and its heartbeat before closing SQLite.
      finish({ success: true, output: 'cleanup', toolsUsed: [], iterations: 0 });
      await beforeCrash.await(agentId);
      db.close();
    }
  });
});
