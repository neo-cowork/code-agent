// Gate: required tools survive run-policy narrowing on four turn kinds, driven
// through the real `inference` entry with the production allowlist builders, the
// real tool registry and real role definitions. Only the model transport is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly';
import { inference } from '../../../src/host/agent/runtime/contextAssembly/inference';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { resetToolSearchService } from '../../../src/host/services/toolSearch/toolSearchService';
import { resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { resolveAgent } from '../../../src/host/agent/agentRegistry';
import { resolveRoleWakeRequiredToolNames } from '../../../src/host/agent/runtime/turnToolFace';
import { withSessionCommandCenterBrain, getTextForegroundToolNamesForPrompt } from '../../../src/host/app/sessionCommandCenterBrain';
import type { ModelConfig } from '../../../src/shared/contract/model';
import type { ToolDefinition } from '../../../src/shared/contract';

const { mockGetApiKey, mockRecordUsage, mockCheckBudget, mockSettings } = vi.hoisted(() => ({
  mockSettings: { current: {} as Record<string, unknown> },
  mockGetApiKey: vi.fn(() => 'mock-key'),
  mockRecordUsage: vi.fn(),
  mockCheckBudget: vi.fn(() => ({ alertLevel: 'none', usagePercentage: 0 })),
}));

vi.mock('../../../src/host/telemetry/contentCache', () => ({
  getContentCache: () => ({ store: vi.fn(() => true), get: vi.fn(() => null) }),
}));
vi.mock('../../../src/host/telemetry/systemPromptCache', () => ({
  getSystemPromptCache: () => ({ get: () => null, store: vi.fn() }),
}));
vi.mock('../../../src/host/telemetry/toolSchemaCache', () => ({
  getToolSchemaCache: () => ({ store: vi.fn(() => true), get: vi.fn(() => null) }),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getApiKey: mockGetApiKey }),
  getAuthService: () => ({ getCurrentUser: vi.fn().mockReturnValue({ isAdmin: false }) }),
  getLangfuseService: () => ({ startGenerationInSpan: vi.fn(), endGeneration: vi.fn() }),
  getBudgetService: () => ({ recordUsage: mockRecordUsage, checkBudget: mockCheckBudget }),
  BudgetAlertLevel: { NONE: 'none', SILENT: 'silent', WARNING: 'warning', BLOCKED: 'blocked' },
}));
vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getAllToolMeta: () => ({}) }),
}));
vi.mock('../../../src/host/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/mcp')>();
  return { ...actual, getMCPClient: () => ({ getToolDefinitions: () => [] }) };
});
vi.mock('../../../src/host/services/core/configService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/core/configService')>();
  return {
    ...actual,
    getConfigService: () => ({
      onSettingsUpdated: vi.fn(),
      getApiKey: () => 'mock-key',
      getServiceApiKey: () => undefined,
      getSettings: () => mockSettings.current,
    }),
  };
});
vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: { agent: vi.fn(), browser: vi.fn() },
}));
vi.mock('../../../src/host/session/streamSnapshot', () => ({
  createSnapshotHandler: vi.fn().mockReturnValue(vi.fn()),
}));
vi.mock('../../../src/host/context/tokenOptimizer', () => ({
  estimateModelMessageTokens: vi.fn().mockReturnValue(12),
  estimateTokens: vi.fn().mockReturnValue(5),
}));
vi.mock('../../../src/host/model/modelRouter', () => ({
  ContextLengthExceededError: class ContextLengthExceededError extends Error {
    requestedTokens = 0;
    maxTokens = 0;
    provider = 'mock';
  },
}));
vi.mock('../../../src/host/prompts/builder', () => ({
  needsArtifactTaskBrief: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../src/host/app/applicationRunRegistry', () => ({
  getConfiguredApplicationRunRegistry: () => ({
    hasDurableOwner: () => true,
    checkpointNativeModelOperation: vi.fn(async () => {}),
  }),
}));


const XIAOMI: ModelConfig = {
  provider: 'xiaomi',
  model: 'mimo-v2.6-flash',
  apiKey: 'mock-key',
  temperature: 0,
  maxTokens: 4096,
};

function buildCtx(prompt: string, allowedToolNames: string[] | undefined): ContextAssemblyCtx {
  const modelRouter = {
    inference: vi.fn().mockResolvedValue({ type: 'text', content: 'ok', finishReason: 'stop' }),
    detectRequiredCapabilities: vi.fn().mockReturnValue([]),
    getModelInfo: vi.fn().mockReturnValue({ supportsVision: true, supportsTool: true, capabilities: ['general'] }),
    getFallbackConfig: vi.fn().mockReturnValue(null),
    getVisionPreflightCandidates: vi.fn().mockReturnValue([]),
  };
  const turn = TurnState.forTest({ currentIterationSpanId: 'span-1', currentTurnId: 'turn-1', effortLevel: 'medium' });
  turn.beginRun(prompt);
  const runtime = {
    enableToolDeferredLoading: false,
    cachePromptSample: {},
    toolScope: undefined,
    stats: RunStatsState.forTest({ traceId: 'trace-tool-face' } as never),
    turn,
    sessionId: 'session-tool-face',
    workingDirectory: '/tmp',
    modelConfig: XIAOMI,
    modelRouter,
    onEvent: vi.fn(),
    control: ControlState.forTest(),
    contextHealth: ContextHealthState.forTest(),
    messages: [{ role: 'user', content: prompt }],
    turnTrace: { record: vi.fn() },
    maxMode: false,
    artifact: ArtifactState.forTest(),
    allowedToolNames,
  } as any;
  return {
    runtime,
    inferenceRecovery: {
      _contextOverflowRetried: false,
      _artifactNonStreamingRetried: false,
      _artifactRepairCompactWriteRetried: false,
      _networkRetried: false,
    },
    taskProgress: { emitTaskProgress: vi.fn() } as any,
    recordTokenUsage: vi.fn(),
    inference: vi.fn(),
    buildModelMessages: vi.fn().mockResolvedValue([
      { role: 'system', content: 'system' },
      { role: 'user', content: prompt },
    ]),
    checkAndAutoCompress: vi.fn(),
  } as any;
}

function finalTable(ctx: ContextAssemblyCtx): string[] {
  const tools = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0]?.[1];
  if (!Array.isArray(tools)) throw new Error('modelRouter.inference was not called with a tools array');
  return (tools as ToolDefinition[]).map((tool) => tool.name);
}

function sentSystemText(ctx: ContextAssemblyCtx): string {
  const messages = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0]?.[0] as Array<{ role: string; content: unknown }>;
  return messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
}

describe('turn tool-face gate (through inference)', () => {
  const previousEngine = process.env.CODE_AGENT_MODEL_ENGINE;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.current = {};
    mockGetApiKey.mockReturnValue('mock-key');
    resetProtocolRegistry();
    resetToolSearchService();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });

  afterEach(() => {
    resetToolSearchService();
    if (previousEngine === undefined) delete process.env.CODE_AGENT_MODEL_ENGINE;
    else process.env.CODE_AGENT_MODEL_ENGINE = previousEngine;
  });

  it('role chat: every declared role tool reaches the final table', async () => {
    const prompt = '请介绍一下当前项目';
    const role = resolveAgent('dream');
    expect(role?.tools?.length).toBeGreaterThan(0);
    const options = withSessionCommandCenterBrain({ agentOverrideId: 'dream' }, prompt);
    const ctx = buildCtx(prompt, options.allowedToolNames);
    await inference(ctx);
    const table = new Set(finalTable(ctx));
    for (const name of role?.tools ?? []) expect(table.has(name), name).toBe(true);
  });

  it('role wake: MemoryWrite-only role also gets connected calendar read tools, no calendar writes', async () => {
    const allowed = await resolveRoleWakeRequiredToolNames(['MemoryWrite'], ['Calendar']);
    const ctx = buildCtx('晨间整理', allowed);
    await inference(ctx);
    const table = new Set(finalTable(ctx));
    expect(table.has('MemoryWrite')).toBe(true);
    expect(table.has('calendar')).toBe(true);
    expect(table.has('calendar_create_event')).toBe(false);
  });

  it('role wake with the calendar not connected: model gets one plain reconnect line', async () => {
    const allowed = await resolveRoleWakeRequiredToolNames(['MemoryWrite'], ['Calendar']);
    mockSettings.current = { connectors: { enabledNative: [] } };
    const ctx = buildCtx('晨间整理', allowed);
    await inference(ctx);
    const system = sentSystemText(ctx);
    expect(system).toContain('<connector-not-ready>');
    expect(system).toContain('Settings > Connectors');
    expect(system).not.toContain('disabled by permission policy');
  });

  it('foreground named browser: delegate_task in the table and the note in the model messages', async () => {
    const prompt = '用浏览器打开 example.com 告诉我标题';
    const ctx = buildCtx(prompt, getTextForegroundToolNamesForPrompt(prompt));
    await inference(ctx);
    const table = finalTable(ctx);
    expect(table).toContain('delegate_task');
    expect(table).not.toContain('Bash');
    const system = sentSystemText(ctx);
    expect(system).toContain('<tool-face-narrowing>');
    expect(system).toContain('delegate_task');
    expect(system).not.toContain('disabled by permission policy');
  });

  it('foreground named Bash: delegate_task in the table and the note in the model messages', async () => {
    const prompt = '用终端执行 ls 看看当前目录';
    const ctx = buildCtx(prompt, getTextForegroundToolNamesForPrompt(prompt));
    await inference(ctx);
    expect(finalTable(ctx)).toContain('delegate_task');
    expect(finalTable(ctx)).not.toContain('Bash');
    expect(sentSystemText(ctx)).toContain('<tool-face-narrowing>');
  });

  it('how-to question about the command line: note is conditional and says to answer directly', async () => {
    const prompt = '命令行里怎么查看端口占用';
    const ctx = buildCtx(prompt, getTextForegroundToolNamesForPrompt(prompt));
    await inference(ctx);
    const system = sentSystemText(ctx);
    expect(system).toContain('only if the user wants a command run now');
    expect(system).toContain('answer directly and do not delegate');
    expect(system).not.toContain('Exit: call');
  });

  it('second iteration after delegate_task in the same turn gets no narrowing note', async () => {
    const prompt = '用浏览器打开 example.com 告诉我标题';
    const ctx = buildCtx(prompt, getTextForegroundToolNamesForPrompt(prompt));
    ctx.runtime.messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'delegate_task', arguments: {} }],
    });
    await inference(ctx);
    expect(sentSystemText(ctx)).not.toContain('<tool-face-narrowing>');
  });

  it('a prompt that names no Bash/browser gets no narrowing note', async () => {
    const prompt = '请快速回答这个问题';
    const ctx = buildCtx(prompt, getTextForegroundToolNamesForPrompt(prompt));
    await inference(ctx);
    expect(sentSystemText(ctx)).not.toContain('<tool-face-narrowing>');
  });

  it('MiMo (xiaomi) foreground: delegate_task present, web_fetch/computer_use absent (decision A)', async () => {
    const prompt = '请快速回答这个问题';
    const ctx = buildCtx(prompt, getTextForegroundToolNamesForPrompt(prompt));
    expect(ctx.runtime.modelConfig.provider).toBe('xiaomi');
    await inference(ctx);
    const table = finalTable(ctx);
    expect(table).toContain('delegate_task');
    expect(table).not.toContain('web_fetch');
    expect(table).not.toContain('computer_use');
  });
});
