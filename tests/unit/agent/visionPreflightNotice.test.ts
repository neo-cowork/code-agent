import { describe, expect, it, vi } from 'vitest';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly';
import type { ModelMessage } from '../../../src/host/agent/loopTypes';
import { formatVisionPreflightNotice } from '../../../src/shared/i18n/visionPreflight';
import { runVisionPreflightCandidates } from '../../../src/host/agent/runtime/contextAssembly/visionPreflight';
import { ZHIPU_VISION_MODEL } from '../../../src/shared/constants';

const { mockLanguage } = vi.hoisted(() => ({ mockLanguage: vi.fn(() => 'zh') }));

// 只替换 UI 语言来源（readPreviewHealthLocale 经此读 ui.language）：zh/en 用例按需切换返回值。
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: mockLanguage() } }) }),
}));

// addAndPersistMessage 的落库降级路径走 sessionManager（本文件 ctx 已注入 persistMessage spy，
// 正常到不了这一步；mock 掉避免拉起真实服务 barrel）。
vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => ({ addMessageToSession: vi.fn().mockResolvedValue(undefined) }),
}));

// 真实 logger 会写盘；本文件断言的是落库消息内容，不需要日志副作用。
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// 主模型/识图候选故意带内部模型 id：断言的目标正是这些 id 不许漏进用户可见的补注。
function buildCtx(): ContextAssemblyCtx {
  return {
    runtime: {
      control: {},
      messages: [],
      sessionId: 'session-vision-notice',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      persistMessage: vi.fn().mockResolvedValue(undefined),
    },
    generateId: vi.fn(() => 'vision-notice-id'),
    recordContextEventsForMessage: vi.fn(),
  } as unknown as ContextAssemblyCtx;
}

const IMAGE_MESSAGE: ModelMessage = {
  role: 'user',
  content: [
    { type: 'text', text: '这张报销单总额是多少？' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
  ],
};

const MODEL_ID_LEAK = /glm-|mimo-|deepseek-|omni|flash/i;

function lastPersistedSystemMessage(ctx: ContextAssemblyCtx) {
  const messages = ctx.runtime.messages as unknown as Array<{ role: string; content: string; metadata?: unknown }>;
  return messages.filter((message) => message.role === 'system').at(-1);
}

describe('vision preflight notice copy', () => {
  it('returns the zh and en notice without model ids', () => {
    expect(formatVisionPreflightNotice('zh')).toBe('已先读取图片内容，再继续回答。');
    expect(formatVisionPreflightNotice('en')).toBe('Read the image first, then continued with your answer.');
  });

  it('persists a zh notice without model ids when the UI language is zh', async () => {
    mockLanguage.mockReturnValue('zh');
    const ctx = buildCtx();

    const result = await runVisionPreflightCandidates(
      ctx,
      [IMAGE_MESSAGE],
      [{ provider: 'xiaomi', model: 'mimo-v2-omni', apiKey: 'key', maxTokens: 4096 }],
      '这张报销单总额是多少？',
      vi.fn().mockResolvedValue({ type: 'text', content: '报销单总额 1234 元。', finishReason: 'stop' }),
    );

    expect(result.succeeded).toBe(true);
    const notice = lastPersistedSystemMessage(ctx);
    expect(notice).toBeDefined();
    expect(notice!.content).toBe('已先读取图片内容，再继续回答。');
    expect(notice!.content).not.toMatch(MODEL_ID_LEAK);
    expect(notice).toHaveProperty('metadata.agentRecoveryNotice.kind', 'vision_preflight_used');
    expect(ctx.runtime.persistMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'system', content: notice!.content }),
    );
  });

  it('persists an en notice without model ids when the UI language is en', async () => {
    mockLanguage.mockReturnValue('en');
    const ctx = buildCtx();

    const result = await runVisionPreflightCandidates(
      ctx,
      [IMAGE_MESSAGE],
      [{ provider: 'zhipu', model: ZHIPU_VISION_MODEL, apiKey: 'key', maxTokens: 4096 }],
      'What is the total on this expense report?',
      vi.fn().mockResolvedValue({ type: 'text', content: 'The total is 1234.', finishReason: 'stop' }),
    );

    expect(result.succeeded).toBe(true);
    const notice = lastPersistedSystemMessage(ctx);
    expect(notice).toBeDefined();
    expect(notice!.content).toBe('Read the image first, then continued with your answer.');
    expect(notice!.content).not.toMatch(MODEL_ID_LEAK);
    expect(notice).toHaveProperty('metadata.agentRecoveryNotice.kind', 'vision_preflight_used');
    expect(ctx.runtime.persistMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'system', content: notice!.content }),
    );
  });
});
