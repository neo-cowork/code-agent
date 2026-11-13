// Production inference + real protocol schemas; only external services/model transport are mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly';
import { inference } from '../../../src/host/agent/runtime/contextAssembly/inference';
import { type CachePromptSampleHolder } from '../../../src/host/agent/runtime/toolTableFingerprint';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { resetToolSearchService } from '../../../src/host/services/toolSearch/toolSearchService';
import { browserActionSchema } from '../../../src/host/plugins/builtin/browserControl/browserAction.schema';
import { browserNavigateSchema } from '../../../src/host/plugins/builtin/browserControl/browserNavigate.schema';
import { browserSchema } from '../../../src/host/plugins/builtin/browserControl/browser.schema';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveRoleChatToolFace } from '../../../src/host/app/morningBriefSaveDraftTools';
import { getTextForegroundToolNamesForPrompt } from '../../../src/host/app/sessionCommandCenterBrain';
import { resolveWakeRunToolScope } from '../../../src/host/services/roleAssets/roleProactivity';
import { writeRolePersonalization } from '../../../src/host/services/roleAssets/rolePersonalization';
import type { ToolDefinition } from '../../../src/shared/contract';

const { mockGetApiKey, mockRecordUsage, mockCheckBudget } = vi.hoisted(() => ({
  mockGetApiKey: vi.fn(() => 'mock-key'),
  mockRecordUsage: vi.fn(),
  mockCheckBudget: vi.fn(() => ({ alertLevel: 'none', usagePercentage: 0 })),
}));

const replayCaches = vi.hoisted(() => ({
  content: new Map<string, string>(),
  tools: new Map<string, string>(),
}));

vi.mock('../../../src/host/telemetry/contentCache', () => ({
  getContentCache: () => ({
    store: (hash: string, content: string) => (replayCaches.content.set(hash, content), true),
    get: (hash: string) => replayCaches.content.get(hash) ?? null,
  }),
}));

vi.mock('../../../src/host/telemetry/systemPromptCache', () => ({
  getSystemPromptCache: () => ({ get: () => null, store: vi.fn() }),
}));

vi.mock('../../../src/host/telemetry/toolSchemaCache', () => ({
  getToolSchemaCache: () => ({
    store: (hash: string, content: string) => (replayCaches.tools.set(hash, content), true),
    get: (hash: string) => replayCaches.tools.get(hash) ?? null,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getApiKey: mockGetApiKey }),
  getAuthService: () => ({ getCurrentUser: vi.fn().mockReturnValue({ isAdmin: false }) }),
  getLangfuseService: () => ({
    startGenerationInSpan: vi.fn(),
    endGeneration: vi.fn(),
  }),
  getBudgetService: () => ({
    recordUsage: mockRecordUsage,
    checkBudget: mockCheckBudget,
  }),
  BudgetAlertLevel: { NONE: 'none', SILENT: 'silent', WARNING: 'warning', BLOCKED: 'blocked' },
}));

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({
    getAllToolMeta: () => ({}),
  }),
}));

vi.mock('../../../src/host/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/mcp')>();
  return {
    ...actual,
    getMCPClient: () => ({
      getToolDefinitions: () => [],
    }),
  };
});

vi.mock('../../../src/host/services/core/configService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/core/configService')>();
  return {
    ...actual,
    getConfigService: () => ({
      onSettingsUpdated: vi.fn(),
      getApiKey: () => 'mock-key',
      getServiceApiKey: () => undefined,
      getSettings: () => ({}),
    }),
  };
});

vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
    browser: vi.fn(),
  },
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

function buildCtx(holder: CachePromptSampleHolder): ContextAssemblyCtx {
  const modelRouter = {
    inference: vi.fn().mockResolvedValue({ type: 'text', content: 'single', finishReason: 'stop' }),
    detectRequiredCapabilities: vi.fn().mockReturnValue([]),
    getModelInfo: vi.fn().mockReturnValue({ supportsVision: true, supportsTool: true, capabilities: ['general'] }),
    getFallbackConfig: vi.fn().mockReturnValue(null),
    getVisionPreflightCandidates: vi.fn().mockReturnValue([]),
  };

  const runtime = {
    enableToolDeferredLoading: true,
    cachePromptSample: holder,
    toolScope: undefined,
    stats: RunStatsState.forTest({ traceId: 'trace-tools' } as never),
    turn: TurnState.forTest({ currentIterationSpanId: 'span-1', currentTurnId: 'turn-1', effortLevel: 'medium' }),
    sessionId: 'session-tools',
    workingDirectory: '/tmp',
    modelConfig: {
      provider: 'mock',
      model: 'test-model',
      apiKey: 'mock-key',
      temperature: 0,
      maxTokens: 4096,
    },
    modelRouter,
    onEvent: vi.fn(),
    control: ControlState.forTest(),
    contextHealth: ContextHealthState.forTest(),
    messages: [],
    turnTrace: { record: vi.fn() },
    maxMode: false,
    artifact: ArtifactState.forTest(),
  } as any;

  return {
    runtime,
    inferenceRecovery: {
      _contextOverflowRetried: false,
      _artifactNonStreamingRetried: false,
      _artifactRepairCompactWriteRetried: false,
      _networkRetried: false,
    },
    taskProgress: {
      emitTaskProgress: vi.fn(),
    } as any,
    recordTokenUsage: vi.fn(),
    inference: vi.fn(),
    buildModelMessages: vi.fn().mockResolvedValue([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'status check' },
    ]),
    checkAndAutoCompress: vi.fn(),
  } as any;
}

function sentTools(ctx: ContextAssemblyCtx): ToolDefinition[] {
  const tools = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0]?.[1];
  if (!Array.isArray(tools)) throw new Error('modelRouter.inference was not called with a tools array');
  return tools as ToolDefinition[];
}


const roles = vi.hoisted(() => ({
  dir: '',
  values: new Map<string, { id: string; tools: string[] }>(),
}));
vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => roles.dir,
  getAgentsMdDir: () => ({ user: path.join(roles.dir, 'agents') }),
}));
vi.mock('../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: (id: string) => roles.values.get(id),
}));

function turn(prompt: string, policy: { allowedToolNames?: string[]; deniedToolNames?: string[] }, agentId = 'default') {
  const ctx = buildCtx({});
  Object.assign(ctx.runtime, policy, {
    agentId,
    messages: [{ role: 'user', content: prompt }],
  });
  ctx.runtime.turn.beginRun(prompt);
  return ctx;
}

async function finalNames(ctx: ContextAssemblyCtx) {
  await inference(ctx);
  return sentTools(ctx).map((tool) => tool.name);
}

describe('ordered tool faces through production inference', () => {
  const previousEngine = process.env.CODE_AGENT_MODEL_ENGINE;
  beforeEach(async () => {
    vi.clearAllMocks();
    roles.values.clear();
    roles.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-face-'));
    resetProtocolRegistry();
    getProtocolRegistry().register(browserSchema, async () => (await import('../../../src/host/plugins/builtin/browserControl/browser')).browserModule);
    getProtocolRegistry().register(browserActionSchema, async () => (await import('../../../src/host/plugins/builtin/browserControl/browserAction')).browserActionModule);
    getProtocolRegistry().register(browserNavigateSchema, async () => (await import('../../../src/host/plugins/builtin/browserControl/browserNavigate')).browserNavigateModule);
    resetToolSearchService();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });
  afterEach(async () => {
    if (previousEngine === undefined) delete process.env.CODE_AGENT_MODEL_ENGINE;
    else process.env.CODE_AGENT_MODEL_ENGINE = previousEngine;
    await fs.rm(roles.dir, { recursive: true, force: true });
  });

  it('role chat keeps every declared schema, rather than intersecting the foreground face', async () => {
    const declared = ['calendar', 'MemoryRead', 'MemoryWrite'];
    roles.values.set('calendar-expert', { id: 'calendar-expert', tools: declared });
    const prompt = '我今天有什么日程';
    const allowedToolNames = resolveRoleChatToolFace(
      prompt, getTextForegroundToolNamesForPrompt(prompt), declared, 'calendar-expert',
    );
    const ctx = turn(prompt, { allowedToolNames }, 'calendar-expert');
    const names = await finalNames(ctx);
    expect(names.sort()).toEqual([...declared].sort());
  });

  it('a role-declared deferred browser survives even when foreground inheritance remains enabled', async () => {
    const declared = ['Browser', 'Read'];
    roles.values.set('browser-expert', { id: 'browser-expert', tools: declared });
    const prompt = '查看 example.com 的标题';
    const ctx = turn(prompt, {
      allowedToolNames: resolveRoleChatToolFace(prompt, getTextForegroundToolNamesForPrompt(prompt), declared, 'browser-expert'),
    }, 'browser-expert');
    Object.assign(ctx.runtime, { foregroundToolFace: true });
    expect((await finalNames(ctx)).sort()).toEqual([...declared].sort());
  });

  it('role wake retains declared read and memory tools through deferred loading', async () => {
    const declared = ['Read', 'calendar', 'MemoryRead', 'MemoryWrite'];
    roles.values.set('wake-expert', { id: 'wake-expert', tools: declared });
    const ctx = turn('检查今天日程并更新你的角色记忆', await resolveWakeRunToolScope('wake-expert'), 'wake-expert');
    Object.assign(ctx.runtime, { unattendedTurn: true });
    expect((await finalNames(ctx)).sort()).toEqual([...declared].sort());
  });

  it.each(['Bash', 'Browser', 'browser_action', 'browser_navigate'])('foreground named %s keeps its delegation exit even on an Office deliverable turn', async (name) => {
    const prompt = `用 ${name} 核对资料，整理成 report.docx`;
    const ctx = turn(prompt, { allowedToolNames: getTextForegroundToolNamesForPrompt(prompt) });
    Object.assign(ctx.runtime, { foregroundToolFace: true });
    const names = await finalNames(ctx);
    expect(names).toContain('delegate_task');
    expect(names).not.toContain('Bash');
    expect(names).not.toContain('Browser');
    expect(names).not.toContain('browser_navigate');
  });

  it('an explicitly named lowercase registered connector tool survives the foreground face', async () => {
    const prompt = '调用 calendar 检查连接';
    const ctx = turn(prompt, { allowedToolNames: getTextForegroundToolNamesForPrompt(prompt) });
    Object.assign(ctx.runtime, { foregroundToolFace: true });
    expect(await finalNames(ctx)).toContain('calendar');
  });

  it('MiMo foreground actually sends deferred allowed tools to provider xiaomi', async () => {
    const prompt = '用浏览器打开 example.com 告诉我标题';
    const ctx = turn(prompt, { allowedToolNames: getTextForegroundToolNamesForPrompt(prompt) });
    Object.assign(ctx.runtime, { foregroundToolFace: true });
    Object.assign(ctx.runtime.modelConfig, { provider: 'xiaomi', model: 'mimo-v2.6-flash' });
    const names = await finalNames(ctx);
    expect(names).toContain('delegate_task');
    expect(names).toContain('spawn_agent');
    expect(names).not.toContain('Bash');
    expect(names).not.toContain('Browser');
    expect(names).not.toContain('browser_navigate');
  });

  it.each(['chat', 'wake'])('no-external-sending role remains inside its declared hard boundary on %s', async (kind) => {
    const id = 'no-sending';
    const declared = ['Read', 'calendar', 'mail_send'];
    roles.values.set(id, { id, tools: declared });
    await fs.mkdir(path.join(roles.dir, 'roles', id), { recursive: true });
    writeRolePersonalization(id, { boundaries: { disallowExternalSending: true } });
    const prompt = '用 Bash 或 delegate_task 帮我发送邮件';
    const policy = kind === 'wake' ? await resolveWakeRunToolScope(id) : {
      allowedToolNames: resolveRoleChatToolFace(prompt, getTextForegroundToolNamesForPrompt(prompt), declared, id),
    };
    const ctx = turn(prompt, policy, id);
    Object.assign(ctx.runtime, { unattendedTurn: kind === 'wake', toolScope: { allowedConnectorIds: ['mail', 'calendar'] } });
    const names = await finalNames(ctx);
    expect(names).toContain('Read');
    expect(names).toContain('calendar');
    expect(names).not.toContain('delegate_task');
    expect(names).not.toContain('Bash');
    expect(names).not.toContain('mail_send');
    expect(names.every((name) => declared.includes(name))).toBe(true);
  });

  it('explicit deny and an inherited narrow allowlist cannot be widened by naming a tool', async () => {
    const ctx = turn('使用 delegate_task 和 Bash 生成 report.docx', {
      allowedToolNames: ['Read'], deniedToolNames: ['delegate_task'],
    });
    expect(await finalNames(ctx)).toEqual(['Read']);
  });
});
