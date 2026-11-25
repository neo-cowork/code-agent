// 用户只要答案（没要求命令/核对）时，自己多加的那步被打回，所有注入位都不许让模型转述「没执行」；
// 用户明确要求了命令/核对/改动，则注入今天完整的五条契约。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ToolCall } from '../../../src/shared/contract';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));
vi.mock('../../../src/host/agent/runtime/turnQuality', () => ({ attachTurnQualityMetadata: () => undefined }));

import { getInabilityReplyGuidance, INABILITY_REPLY_CONTRACT } from '../../../src/shared/inabilityReplyContract';
import { sealBouncedToolCalls } from '../../../src/host/agent/runtime/bouncedToolCallSeal';
import { describeDeniedShellCalls } from '../../../src/host/agent/runtime/foregroundShellDenial';
import { deniedToolRetryGuidance } from '../../../src/host/agent/runtime/toolRunPolicy';
import { settleForegroundToolDenial } from '../../../src/host/agent/runtime/foregroundDenialHandoff';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';

const NARRATION = /没有执行|没执行|NOT run|did not happen|did not run/;
const NO_CUE = { zh: '帮我把这 10 笔报销金额加起来，告诉我总数', en: 'add these 10 reimbursement amounts up and tell me the total' };
const CUE = { zh: '用命令核对一下这 10 笔报销金额', en: 'double-check these amounts with a command' };
const CUE_MUTATE = { zh: '帮我整理下载文件夹', en: 'delete the old files' };

function makeCtx(prompt: string): RuntimeContext {
  const turn = new TurnState();
  turn.beginRun(prompt);
  return {
    sessionId: 's', turn, onEvent: vi.fn(), messages: [], maxToolCallRetries: 5,
    deniedToolNames: ['Bash'], foregroundToolFace: false,
  } as unknown as RuntimeContext;
}

async function seal(prompt: string, skipped: boolean): Promise<string> {
  const persisted: Message[] = [];
  const contextAssembly = {
    generateId: () => 'm', addAndPersistMessage: vi.fn(async (m: Message) => { persisted.push(m); }),
  } as unknown as ContextAssembly;
  const calls = [
    { id: 'c1', name: 'Bash', arguments: { command: 'echo' } },
    { id: 'c2', name: 'Read', arguments: { file_path: 'a' } },
  ] as ToolCall[];
  await sealBouncedToolCalls({ ctx: makeCtx(prompt), contextAssembly }, { content: '' } as ModelResponse, calls, 'denied', new Set(['c1']));
  const results = persisted.find((m) => m.role === 'tool')!.toolResults!;
  return String(results[skipped ? 1 : 0].error);
}

async function handoffText(prompt: string): Promise<string> {
  const injected: string[] = [];
  const contextAssembly = {
    generateId: () => 'm', addAndPersistMessage: vi.fn(), injectSystemMessage: (t: string) => { injected.push(t); },
  } as unknown as ContextAssembly;
  const toolCalls = [{ id: 'c1', name: 'Bash', arguments: { command: 'echo' } }] as ToolCall[];
  await settleForegroundToolDenial({
    ctx: makeCtx(prompt), contextAssembly, guard: { toolCallRetryCount: 0 },
    response: { content: '' } as ModelResponse, toolCalls, planModeActive: () => false,
  });
  return injected.join('\n');
}

describe.each(['zh', 'en'] as const)('unrequested check bounce (%s)', (locale) => {
  beforeEach(() => { getProtocolRegistry(); });

  it('no-cue prompt: no injected text narrates "not run"', async () => {
    const prompt = NO_CUE[locale];
    expect(await seal(prompt, false)).not.toMatch(NARRATION);
    expect(await seal(prompt, true)).not.toMatch(NARRATION);
    expect(describeDeniedShellCalls(makeCtx(prompt), [{ name: 'Bash' }])?.guidance).not.toMatch(NARRATION);
    expect(deniedToolRetryGuidance(makeCtx(prompt))).not.toMatch(NARRATION);
    expect(await handoffText(prompt)).not.toMatch(NARRATION);
  });

  it.each([CUE[locale], CUE_MUTATE[locale]])('cue prompt %s: full contract unchanged', async (prompt) => {
    const full = `${INABILITY_REPLY_CONTRACT[locale].guidance}\n${locale === 'en' ? 'Reply in English.' : '用中文回复。'}`;
    expect(getInabilityReplyGuidance(prompt)).toBe(full);
    expect(await seal(prompt, false)).toBe(full);
    expect(await seal(prompt, true)).toBe(full);
    expect(describeDeniedShellCalls(makeCtx(prompt), [{ name: 'Bash' }])?.guidance).toBe(full);
    expect(deniedToolRetryGuidance(makeCtx(prompt)).startsWith(full)).toBe(true);
    const text = await handoffText(prompt);
    expect(text).toContain(full);
    expect(text).toContain('The previous call was NOT run.');
  });
});
