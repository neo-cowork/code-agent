// 门打回整批工具调用时，合成的 tool 结果文本是模型最容易原样转述给用户的一句话：
// 不许带内部机制黑话，错误码 / 元数据保持不变。
import { describe, expect, it, vi } from 'vitest';
import type { Message, ToolCall } from '../../../src/shared/contract';
import { wrapWithTurnSystemContext } from '../../../src/shared/utils/turnScaffold';
import { getInabilityReplyGuidance } from '../../../src/shared/inabilityReplyContract';
import { sealBouncedToolCalls } from '../../../src/host/agent/runtime/bouncedToolCallSeal';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';

vi.mock('../../../src/host/agent/runtime/turnQuality', () => ({ attachTurnQualityMetadata: () => undefined }));

const BANNED = /被禁用|本轮|这一轮|本次运行|disabled for this|tool face|bash|shell/i;

async function seal(kind: 'goal' | 'denied' | 'repair', denied?: Set<string>, runUserPrompt = '') {
  const persisted: Message[] = [];
  let n = 0;
  const contextAssembly = {
    generateId: () => `m${++n}`,
    addAndPersistMessage: vi.fn(async (m: Message) => { persisted.push(m); }),
  } as unknown as ContextAssembly;
  const ctx = { onEvent: vi.fn(), turn: { effortLevel: undefined, currentTurnId: 't1', runUserPrompt } } as unknown as RuntimeContext;
  const calls = [
    { id: 'c1', name: 'Bash', arguments: { command: 'rm x' } },
    { id: 'c2', name: 'Read', arguments: { file_path: 'a' } },
  ] as ToolCall[];
  await sealBouncedToolCalls({ ctx, contextAssembly }, { content: '' } as ModelResponse, calls, kind, denied);
  return persisted.find((m) => m.role === 'tool')!.toolResults!;
}

describe('sealBouncedToolCalls wording', () => {
  it('denied: denied call and skipped sibling read as everyday speech, codes/metadata unchanged', async () => {
    const results = await seal('denied', new Set(['c1']));
    expect(results.map((r) => r.error)).toHaveLength(2);
    for (const r of results) {
      expect(r.error).not.toMatch(BANNED);
      expect(r.error).toBe(getInabilityReplyGuidance('', 'zh'));
      expect(r.success).toBe(false);
      expect(r.metadata).toMatchObject({ skipped: true, bounced: true });
    }
    expect(results[0].metadata?.code).toBe('TOOL_DISABLED_FOR_RUN');
    expect(results[1].metadata?.code).toBe('TOOL_BATCH_SKIPPED');
    expect(results[0].error).toContain('没有执行');
  });

  it('denied without explicit call ids still relays the shared contract', async () => {
    for (const result of await seal('denied')) {
      expect(result.error).toBe(getInabilityReplyGuidance('', 'zh'));
      expect(result.metadata).toEqual({ skipped: true, bounced: true });
    }
  });

  it('English request with Chinese scaffolding relays English guidance to both denied and skipped calls', async () => {
    const prompt = wrapWithTurnSystemContext(['只查看当前任务文件夹。没有上传附件，不要搜索其他位置。'],
      'Please compress the notes folder into notes-backup.zip in the current directory.');
    const results = await seal('denied', new Set(['c1']), prompt);
    for (const result of results) expect(result.error).toBe(getInabilityReplyGuidance(prompt));
    expect(results[0].metadata?.code).toBe('TOOL_DISABLED_FOR_RUN');
    expect(results[1].metadata?.code).toBe('TOOL_BATCH_SKIPPED');
  });

  it('goal / repair bounce texts also stay free of mechanism tokens', async () => {
    for (const kind of ['goal', 'repair'] as const) {
      for (const r of await seal(kind)) expect(r.error).not.toMatch(BANNED);
    }
  });
});
