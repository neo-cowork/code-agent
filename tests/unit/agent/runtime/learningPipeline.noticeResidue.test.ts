// ============================================================================
// N-FIX-TELEMETRY-RECOVERY-NOTICE-RESIDUE-SKILLDRAFT-TITLE — 技能复盘链不吃恢复提示
// 生产类 LearningPipeline（非拷贝）真跑 runSessionEndLearning：
// 旧前缀在进 quick model 与 pattern key 之前剥掉；只剩提示的消息按空消息处理，
// 不计入 SKILL_REVIEW.MIN_USER_TURNS。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getSkillsDir: () => ({
    user: {
      new: path.join(mockConfigDir.dir, 'skills'),
      legacy: path.join(mockConfigDir.dir, 'skills-legacy'),
    },
  }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../../src/host/telemetry/telemetryStorage', () => ({
  getTelemetryStorage: () => ({ getToolCallsBySession: () => [] }),
}));

// 捕获投喂给 quick model 的完整 prompt；返回合法 skill JSON 让整条链走通。
const memoryMocks = vi.hoisted(() => ({
  memoryTask: vi.fn(async () => ({
    success: true,
    content: JSON.stringify({
      shouldCreate: true,
      signal: 'remember_request',
      name: 'summarizing-meeting-notes',
      description: '把多页会议纪要整理成一份周报的流程',
      applicability: {
        semantic: '当前任务需要把多页会议纪要汇总成一份周报',
        requires_tools: [],
        platforms: ['darwin'],
        required_env: [],
        requires_paths: [],
      },
      body: '## 步骤\n- 先合并三页要点再压缩成周报',
    }),
  })),
}));
vi.mock('../../../../src/host/model/quickModel', () => ({ memoryTask: memoryMocks.memoryTask }));
vi.mock('../../../../src/host/services/skills/distillSignalStore', () => ({
  hasDistillSuggestionForSession: () => false,
  recordDistillSignal: () => ({ distinctSessionCount: 2, inserted: true }),
  recordDistillSuggestion: vi.fn(),
}));
vi.mock('../../../../src/host/services/infra/timeoutController', () => ({
  withTimeout: <T>(p: Promise<T>) => p,
}));

import { LearningPipeline } from '../../../../src/host/agent/runtime/learningPipeline';
import { listSkillDrafts } from '../../../../src/host/services/skills/skillDraftQueue';
import type { AgentEvent } from '../../../../src/shared/contract';

const LEGACY_NOTICE =
  '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';
const LEAK = /历史恢复提示|telemetry|重建|脱敏/;

beforeEach(async () => {
  mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-notice-'));
  memoryMocks.memoryTask.mockClear();
});
afterEach(async () => {
  await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
});

function makeCtx(userMessages: string[]) {
  const events: AgentEvent[] = [];
  return {
    events,
    ctx: {
      sessionId: `sess-notice-${Math.random().toString(36).slice(2)}`,
      onEvent: (e: AgentEvent) => events.push(e),
      messages: [
        ...userMessages.map((content) => ({ role: 'user', content })),
        { role: 'assistant', content: '已整理完成' },
      ],
    } as unknown as ConstructorParameters<typeof LearningPipeline>[0],
  };
}

describe('runConversationReviewDistillation 不吃恢复提示', () => {
  it('首条消息带旧前缀：quick model prompt 与 pattern key 只含真实用户原话', async () => {
    const { events, ctx } = makeCtx([
      `${LEGACY_NOTICE}\n\n帮我把三页会议纪要整理成一份周报`,
      '记住：周报末尾总要附上待办清单',
    ]);
    await new LearningPipeline(ctx).runSessionEndLearning();

    expect(memoryMocks.memoryTask).toHaveBeenCalledTimes(1);
    const prompt = String((memoryMocks.memoryTask.mock.calls[0] as unknown[])[0]);
    expect(prompt).toContain('帮我把三页会议纪要整理成一份周报');
    expect(prompt).toContain('记住：周报末尾总要附上待办清单');
    expect(prompt).not.toMatch(LEAK);

    const drafts = await listSkillDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].patternKey).not.toMatch(LEAK);
    expect(drafts[0].patternKey).toContain('周报');
    expect(JSON.stringify(events)).not.toMatch(LEAK);
  });

  it('只剩提示的消息按空消息处理，不计入 MIN_USER_TURNS：单条真实消息不触发复盘', async () => {
    const { ctx } = makeCtx([
      `${LEGACY_NOTICE}\n\n`,
      '帮我把三页会议纪要整理成一份周报',
    ]);
    await new LearningPipeline(ctx).runSessionEndLearning();
    // 清洗后只剩 1 轮有效用户消息 < SKILL_REVIEW.MIN_USER_TURNS(2)：不投喂模型、不入队
    expect(memoryMocks.memoryTask).not.toHaveBeenCalled();
    expect(await listSkillDrafts()).toEqual([]);
  });

  it('截断的提示残留（剥不掉前缀）同样按空消息处理', async () => {
    const { ctx } = makeCtx([
      `${LEGACY_NOTICE.slice(0, 60)}...`,
      '帮我把三页会议纪要整理成一份周报',
    ]);
    await new LearningPipeline(ctx).runSessionEndLearning();
    expect(memoryMocks.memoryTask).not.toHaveBeenCalled();
  });
});
