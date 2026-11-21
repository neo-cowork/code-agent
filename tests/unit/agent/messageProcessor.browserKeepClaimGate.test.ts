// Production finalization path (MessageProcessor.handleTextResponse) for the browser keep-claim gate.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services', () => ({ getSessionManager: () => ({ addMessage: vi.fn(), addMessageToSession: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/mcp/logCollector.js', () => ({ logCollector: { agent: vi.fn(), tool: vi.fn(), browser: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('../../../src/host/config/hostUiLocale', () => ({ getHostUiLocale: () => 'zh' }));
const registry = vi.hoisted(() => ({ state: 'none' as 'none' | 'kept' }));
vi.mock('../../../src/host/services/surfaceExecution/keptBrowserRegistry', () => ({
  getKeptBrowserRegistry: () => ({ snapshot: () => ({ state: registry.state }) }),
}));

import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { BROWSER_KEEP_CLAIM_GATE_WARNING } from '../../../src/shared/i18n/browserKeepClaimGateWarning';

function setup(userText: string, opts: { toolsUsed?: string[]; browserEngine?: string } = {}) {
  const ctx = {
    sessionId: 'sess-keep-1',
    workingDirectory: '/tmp',
    artifact: ArtifactState.forTest(),
    messages: [
      { id: 'u1', role: 'user', content: userText, timestamp: Date.now() },
      ...(opts.browserEngine ? [
        { id: 'a1', role: 'assistant', content: '', timestamp: Date.now() + 1, toolCalls: [{ id: 'tc1', name: 'Browser', arguments: { action: 'navigate', url: 'https://example.com', engine: opts.browserEngine } }] },
        { id: 't1', role: 'tool', content: '', timestamp: Date.now() + 2, toolResults: [{ toolCallId: 'tc1', success: true, output: 'ok' }] },
      ] : []),
    ] as Array<Record<string, unknown>>,
    modelConfig: { provider: 'zhipu', model: 'glm-5', maxTokens: 16384 },
    contextHealth: ContextHealthState.forTest({ currentSystemPromptHash: 'h' } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 't1', currentIterationSpanId: 'i1', researchModeActive: false, toolsUsedInTurn: opts.toolsUsed ?? (opts.browserEngine ? ['Browser'] : ['browser_action']), isSimpleTaskMode: false } as never),
    turnQualityState: {},
    control: ControlState.forTest({ runAbortController: { signal: { aborted: false } } } as never),
    stats: RunStatsState.forTest({ totalToolCallCount: 1 } as never),
    enableDeliveryCritic: false,
    nudgeManager: { runNudgeChecks: vi.fn(() => false), runOutputValidation: vi.fn(() => false), getModifiedFiles: vi.fn(() => new Set<string>()), getModifiedFilesSince: vi.fn(() => []) },
    onEvent: vi.fn(),
    telemetryAdapter: { onTurnEnd: vi.fn() },
  };
  const assembly = {
    stripInternalFormatMimicry: vi.fn((c: string) => c),
    generateId: vi.fn().mockReturnValue('a1'),
    addAndPersistMessage: vi.fn(async (m: Record<string, unknown>) => { ctx.messages.push(m); }),
    injectSystemMessage: vi.fn(),
    updateContextHealth: vi.fn(),
  };
  const finalizer = { emitTaskProgress: vi.fn(), emitTaskComplete: vi.fn(), tryParseTodosFromResponse: vi.fn() };
  const processor = new MessageProcessor(ctx as unknown as RuntimeContext, assembly as unknown as ContextAssembly, finalizer as unknown as RunFinalizer, {} as ToolExecutionEngine);
  const reply = (content: string, iterations: number) => processor.handleTextResponse(
    { type: 'text', content, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as never, false, iterations, false, { endSpan: vi.fn() },
  );
  return { assembly, reply };
}

describe('MessageProcessor browser keep-claim gate', () => {
  beforeEach(() => { warn.mockClear(); registry.state = 'none'; });

  it('retries the first false "window kept" claim, then persists the warning prefix on the second', async () => {
    const { assembly, reply } = setup('订好会议室，把结果页留给我');
    const claim = '已订好，窗口会停留在这个结果页，没有关闭。';

    expect(await reply(claim, 2)).toBe('continue');
    expect(assembly.injectSystemMessage).toHaveBeenCalledWith(expect.stringContaining('<browser-keep-claim-guard>'), 'browser-keep-claim-guard');
    expect(assembly.addAndPersistMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[BrowserKeepClaimGate] retrying'), expect.objectContaining({ reason: 'browser_keep_claim_without_kept_entry:retry:browser_tool_used' }));

    expect(await reply(claim, 3)).toBe('break');
    const persisted = assembly.addAndPersistMessage.mock.calls[0][0] as { content: string };
    expect(persisted.content.startsWith(BROWSER_KEEP_CLAIM_GATE_WARNING.zh)).toBe(true);
    expect(persisted.content).toContain(claim);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[BrowserKeepClaimGate] warning prepended'), expect.objectContaining({ reason: 'browser_keep_claim_without_kept_entry:warn:browser_tool_used' }));
  });

  it('writes a self-contained warning prefix that still reads correctly when a sub-task result is relayed', async () => {
    const { assembly, reply } = setup('把结果页留给我');
    const claim = '窗口未关闭，你可以继续查看。';
    expect(await reply(claim, 2)).toBe('continue');
    expect(await reply(claim, 3)).toBe('break');
    const content = (assembly.addAndPersistMessage.mock.calls[0][0] as { content: string }).content;
    expect(content.startsWith(BROWSER_KEEP_CLAIM_GATE_WARNING.zh)).toBe(true);
    expect(content).not.toContain('下面');
    expect(BROWSER_KEEP_CLAIM_GATE_WARNING.en).not.toMatch(/below/i);
  });

  it('relay-only run: the page really stays open in the user\'s Chrome, so the reply passes unchanged', async () => {
    const { assembly, reply } = setup('帮我在我的 Chrome 里打开 example.com', { browserEngine: 'relay' });
    expect(await reply('页面还开着，你可以直接看。', 2)).toBe('break');
    expect(assembly.injectSystemMessage).not.toHaveBeenCalledWith(expect.anything(), 'browser-keep-claim-guard');
    expect((assembly.addAndPersistMessage.mock.calls[0][0] as { content: string }).content).toBe('页面还开着，你可以直接看。');
  });

  it('document-editing run without any browser call: 保留了页面其他设置 passes unchanged', async () => {
    const { assembly, reply } = setup('把页面边距改窄', { toolsUsed: ['Edit'] });
    expect(await reply('已调整，保留了页面其他设置。', 2)).toBe('break');
    expect((assembly.addAndPersistMessage.mock.calls[0][0] as { content: string }).content).toBe('已调整，保留了页面其他设置。');
  });

  it('passes the claim through untouched when a kept entry exists', async () => {
    registry.state = 'kept';
    const { assembly, reply } = setup('把结果页留给我');
    expect(await reply('窗口保留着，你可以直接看。', 2)).toBe('break');
    expect((assembly.addAndPersistMessage.mock.calls[0][0] as { content: string }).content).toBe('窗口保留着，你可以直接看。');
  });
});
