import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false, getTodos: () => [] }),
}));
vi.mock('../../../src/host/agent/runtime/runtimeStatePersistence', () => ({
  loadPersistedRuntimeState: () => null,
  persistRuntimeState: vi.fn(),
}));
vi.mock('../../../src/host/agent/runtime/turnCostPersistence', () => ({
  createTurnCostEventHandler: ({ onEvent }: { onEvent: unknown }) => onEvent,
}));
vi.mock('../../../src/host/telemetry/telemetryAdapter', () => ({
  createTelemetryAdapter: () => undefined,
}));
vi.mock('../../../src/host/services/skills/comboRecorder', () => ({
  getComboRecorder: () => ({ startRecording: vi.fn(), markTurn: vi.fn() }),
}));
vi.mock('../../../src/host/context/autoCompressor', () => ({
  getAutoCompressor: () => ({}),
}));
vi.mock('../../../src/host/services', () => ({
  getBudgetService: () => ({ checkBudget: () => ({ exceeded: false, usagePercentage: 0 }) }),
  getSessionManager: () => ({ getTodos: () => [] }),
}));
vi.mock('../../../src/host/context/contextEventLedger', () => ({
  getContextEventLedger: () => ({ append: vi.fn(), upsertEvents: vi.fn() }),
}));
vi.mock('../../../src/host/agent/runtime/jevWarden', () => ({
  createJevWarden: () => ({ interceptFinal: vi.fn(), reviewToolStep: vi.fn() }),
}));
vi.mock('../../../src/host/agent/persistentRoleResolution', () => ({
  resolvePersistentRoleId: async () => undefined,
}));
vi.mock('../../../src/host/agent/capabilityGapTurnRecorder', () => ({
  recordCapabilityGapTurn: vi.fn(),
}));
vi.mock('../../../src/host/agent/runtime/workDirectoryMaterializer', () => ({
  beginWorkDirectoryRun: vi.fn(),
  endWorkDirectoryRun: vi.fn(),
}));
vi.mock('../../../src/host/observability/posthogNode', () => ({
  trackNode: vi.fn(),
}));
vi.mock('../../../src/host/agent/runtime/turnOutcomeStamp', () => ({
  recordTurnOutcomeStamp: vi.fn(),
}));
vi.mock('../../../src/host/services/roleAssets/roleProactivity', () => ({
  triggerEventWakes: vi.fn(),
}));
vi.mock('../../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: () => [],
}));
vi.mock('../../../src/host/services/core/promptSuggestions', () => ({
  generateContextSuggestions: async () => [],
}));

import { AgentLoop } from '../../../src/host/agent/agentLoop';
import { withSessionCommandCenterBrain } from '../../../src/host/app/sessionCommandCenterBrain';
import { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import * as replyEgressModule from '../../../src/shared/replyEgressLeakDetect';

function createRealContextAssembly(
  runUserPrompt: string,
  options: { historyVisibility?: 'meta' } = {},
) {
  const persisted: Message[] = [];
  const loop = new AgentLoop({
    ...withSessionCommandCenterBrain({ maxIterations: 6 }, runUserPrompt),
    foregroundToolFace: true,
    historyVisibility: options.historyVisibility,
    modelConfig: { provider: 'openai', model: 'test-model', apiKey: 'test' },
    toolExecutor: {} as never,
    messages: [],
    onEvent: vi.fn(),
    sessionId: 'reply-egress-session',
    workingDirectory: '/tmp',
    memoryMode: 'off',
    enableHooks: false,
    persistLongTermMemory: false,
    persistMessage: async (message) => {
      persisted.push(structuredClone(message));
    },
  });
  const ctx = (loop as unknown as { ctx: RuntimeContext }).ctx;
  ctx.turn.beginRun(runUserPrompt);
  const assembly = new ContextAssembly(ctx);
  return { ctx, assembly, persisted };
}

describe('ContextAssembly.addAndPersistMessage ReplyEgress probe', () => {
  let tmpLogDir = '';
  let consoleErrorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-egress-log-'));
    vi.stubEnv('CODE_AGENT_CLI_MODE', '');
    vi.stubEnv('CODE_AGENT_LOG_DIR', tmpLogDir);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (tmpLogDir) {
      fs.rmSync(tmpLogDir, { recursive: true, force: true });
    }
  });

  function replyEgressCalls() {
    return consoleErrorSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('[ReplyEgress]'),
    );
  }

  it('persists a leaking assistant message unchanged and emits exactly one ReplyEgress log line with right categories', async () => {
    const { ctx, assembly, persisted } = createRealContextAssembly('打开这个网页截图发我并总结');
    const originalContent =
      '抱歉，我的工具列表里没有 browser_action，而且本轮 Bash 不可用，暂时不能直接打开页面。';
    const message: Message = {
      id: 'msg-leak-1',
      role: 'assistant',
      content: originalContent,
      timestamp: 1_700_000_000_000,
    };

    await assembly.addAndPersistMessage(message);

    expect(persisted).toHaveLength(1);
    expect(persisted[0].content).toBe(originalContent);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toBe(originalContent);

    const calls = replyEgressCalls();
    expect(calls).toHaveLength(1);
    const [header, payload] = calls[0] as [string, Record<string, unknown>];
    expect(header).toContain('WARN [ReplyEgress] Reply egress leak detected');
    expect(payload).toMatchObject({
      reason: 'reply_egress_leak_detected',
      sessionId: 'reply-egress-session',
      messageId: 'msg-leak-1',
      categories: expect.arrayContaining(['internal_tool_name', 'mechanism_talk']),
    });
    expect(payload.matches).toEqual(expect.arrayContaining(['browser_action', '工具列表里']));
    expect(JSON.stringify(payload)).not.toContain(originalContent);
  });

  it('emits english_reply_to_zh via real turn.runUserPrompt and stays silent on clean or meta messages', async () => {
    const { assembly, persisted } = createRealContextAssembly('查一下我明天的日程再回邮件');
    const englishReply =
      'Both mail and calendar connectors are connected. Now let me take stock of accounts and pull recent data.';

    await assembly.addAndPersistMessage({
      id: 'msg-en-leak',
      role: 'assistant',
      content: englishReply,
      timestamp: 1_700_000_000_001,
    });
    await assembly.addAndPersistMessage({
      id: 'msg-clean-zh',
      role: 'assistant',
      content: '已帮你查好明天的日程，共两场会议，邮件草稿也准备好了。',
      timestamp: 1_700_000_000_002,
    });

    const { assembly: metaAssembly } = createRealContextAssembly('帮我清理文件', {
      historyVisibility: 'meta',
    });
    await metaAssembly.addAndPersistMessage({
      id: 'msg-meta',
      role: 'assistant',
      content: '本轮 Bash 不可用，工具列表里没有 browser_action。',
      timestamp: 1_700_000_000_003,
    });

    expect(persisted).toHaveLength(2);
    expect(persisted[0].content).toBe(englishReply);

    const calls = replyEgressCalls();
    expect(calls).toHaveLength(1);
    const [, payload] = calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({
      reason: 'reply_egress_leak_detected',
      messageId: 'msg-en-leak',
      categories: ['english_reply_to_zh'],
    });
    expect(JSON.stringify(payload)).not.toContain(englishReply);
  });

  it('never stops persistence when the detector throws, and logs warn with distinguishable reason', async () => {
    const { assembly, persisted } = createRealContextAssembly('帮我把桌面上的临时文件删掉');
    vi.spyOn(replyEgressModule, 'detectReplyEgressLeaks').mockImplementationOnce(() => {
      throw new Error('simulated detector failure');
    });

    const message: Message = {
      id: 'msg-throw-1',
      role: 'assistant',
      content: '已为你检查桌面文件。',
      timestamp: 1_700_000_000_010,
    };

    await expect(assembly.addAndPersistMessage(message)).resolves.toBeUndefined();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].content).toBe('已为你检查桌面文件。');

    const calls = replyEgressCalls();
    expect(calls).toHaveLength(1);
    const [header, payload] = calls[0] as [string, Record<string, unknown>];
    expect(header).toContain('WARN [ReplyEgress] Reply egress probe failed');
    expect(payload).toMatchObject({
      reason: 'reply_egress_probe_error',
      sessionId: 'reply-egress-session',
      messageId: 'msg-throw-1',
      error: 'simulated detector failure',
    });
  });
});
