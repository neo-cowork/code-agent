// Production finalization path (MessageProcessor.handleTextResponse): stray "open <expert>" tail line after propose_role.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';

const warn = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services', () => ({ getSessionManager: () => ({ addMessage: vi.fn(), addMessageToSession: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info, warn, error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info, warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/mcp/logCollector.js', () => ({ logCollector: { agent: vi.fn(), tool: vi.fn(), browser: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('../../../src/host/config/hostUiLocale', () => ({ getHostUiLocale: () => 'zh' }));

import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

function setup(proposed: string[]) {
  const ctx = {
    sessionId: 'sess-role-1',
    workingDirectory: '/tmp',
    artifact: ArtifactState.forTest(),
    messages: [
      { id: 'u1', role: 'user', content: '/create-role 日程助理RR114，专门帮我查看日历', timestamp: Date.now() },
      ...proposed.map((roleId, i) => ({ id: `a${i}`, role: 'assistant', content: '', timestamp: Date.now() + 1, toolCalls: [{ id: `tc${i}`, name: 'propose_role', arguments: { roleId } }] })),
    ] as Array<Record<string, unknown>>,
    modelConfig: { provider: 'zhipu', model: 'glm-5', maxTokens: 16384 },
    contextHealth: ContextHealthState.forTest({ currentSystemPromptHash: 'h' } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 't1', currentIterationSpanId: 'i1', researchModeActive: false, toolsUsedInTurn: proposed.length ? ['propose_role'] : [], isSimpleTaskMode: false } as never),
    turnQualityState: {},
    control: ControlState.forTest({ runAbortController: { signal: { aborted: false } } } as never),
    stats: RunStatsState.forTest({ totalToolCallCount: proposed.length } as never),
    enableDeliveryCritic: false,
    nudgeManager: { runNudgeChecks: vi.fn(() => false), runOutputValidation: vi.fn(() => false), getModifiedFiles: vi.fn(() => new Set<string>()), getModifiedFilesSince: vi.fn(() => []) },
    onEvent: vi.fn(),
    telemetryAdapter: { onTurnEnd: vi.fn() },
  };
  const assembly = {
    stripInternalFormatMimicry: vi.fn((c: string) => c),
    generateId: vi.fn().mockReturnValue('a-final'),
    addAndPersistMessage: vi.fn(async (m: Record<string, unknown>) => { ctx.messages.push(m); }),
    injectSystemMessage: vi.fn(),
    updateContextHealth: vi.fn(),
  };
  const finalizer = { emitTaskProgress: vi.fn(), emitTaskComplete: vi.fn(), tryParseTodosFromResponse: vi.fn() };
  const processor = new MessageProcessor(ctx as unknown as RuntimeContext, assembly as unknown as ContextAssembly, finalizer as unknown as RunFinalizer, {} as ToolExecutionEngine);
  const run = async (content: string) => {
    await processor.handleTextResponse(
      { type: 'text', content, contentParts: [{ type: 'text', text: content }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as never, false, 2, false, { endSpan: vi.fn() },
    );
    const saved = assembly.addAndPersistMessage.mock.calls.at(-1)![0] as { content: string; contentParts?: Array<{ type: string; text?: string }> };
    return { content: saved.content, parts: (saved.contentParts ?? []).map((p) => p.text ?? '').join('') };
  };
  return { run };
}

const BODY = '草稿好了，你可以直接点确认创建，或告诉我要改什么。';

describe('MessageProcessor strips stray "open <expert>" tail after propose_role', () => {
  beforeEach(() => { info.mockClear(); });

  it('removes the trailing line from content and contentParts, keeps earlier paragraphs', async () => {
    const { run } = setup(['日程助理RR114']);
    const out = await run(`${BODY}\n\n第二段说明。\n\n打开日程助理RR114`);
    expect(out.content).toBe(`${BODY}\n\n第二段说明。`);
    expect(out.parts).toBe(out.content);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('[RoleOpenLinkStrip]'), expect.objectContaining({ roleId: '日程助理rr114' }));
  });

  it('removes wrapped forms (bullet, bold, quotes)', async () => {
    const { run } = setup(['日程助理RR114']);
    expect((await run(`${BODY}\n\n→ **「打开日程助理RR114」**`)).content).toBe(BODY);
  });

  it('removes the English form when it equals the roleId', async () => {
    const { run } = setup(['Schedule Assistant']);
    expect((await run('Draft ready.\n\nOpen Schedule Assistant')).content).toBe('Draft ready.');
  });

  it('keeps the line when the turn never called propose_role', async () => {
    const { run } = setup([]);
    const text = `${BODY}\n\n打开日程助理RR114`;
    expect((await run(text)).content).toBe(text);
  });

  it('keeps unrelated or different-name lines', async () => {
    const { run } = setup(['日程助理RR114']);
    const a = `${BODY}\n\n打开设置看看`;
    expect((await run(a)).content).toBe(a);
    const b = `${BODY}\n\n打开别的专家`;
    expect((await run(b)).content).toBe(b);
    const c = `${BODY}\n\n打开日程助理RR114 开始使用`;
    expect((await run(c)).content).toBe(c);
  });

  it('keeps a mid-reply occurrence that is not the last line', async () => {
    const { run } = setup(['日程助理RR114']);
    const text = `打开日程助理RR114\n\n${BODY}`;
    expect((await run(text)).content).toBe(text);
  });
});
