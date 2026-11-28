// ============================================================================
// N-FIX-GOALTRACKER-RECOVERY-NOTICE-RESIDUE — GoalTracker 恢复提示清洗回归
// 由运行记录还原的消息整段以「【历史恢复提示】」开头：GoalTracker 必须只记用户原话，
// 只剩提示残留的按没有正文处理（不初始化、不产 checkpoint），否则 checkpoint 与
// max-steps 收尾会把免责声明当成用户目标回显。
// 提示全文与 src/shared/telemetryRecovery.ts 的私有常量逐字一致（那里不导出，
// 测试按票要求复制文本，不为测试新增导出）。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { GoalTracker } from '../../../src/host/agent/goalTracker';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import {
  activateMaxStepsFinalResponse,
  ensureMaxStepsWrapUp,
} from '../../../src/host/agent/runtime/maxStepsFallback';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

vi.mock('../../../src/host/services', () => ({ getBudgetService: vi.fn() }));

const LEGACY_NOTICE =
  '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';
const CURRENT_NOTICE =
  '【历史恢复提示】这条用户消息是根据 App 的运行记录还原的，措辞、路径和数字可能被缩短或写错，不要把缩短的路径当作确切目标。用户问起这条消息时，只对用户说「这条消息是根据运行记录还原的，路径可能不完整」，并请用户给出完整路径，或把文件直接发给你。不要为了找这个缩短的路径去搜索整台电脑或用户的个人文件夹。回复里不要出现 telemetry、重建、脱敏、home、shell、Glob 这些词，也不要提任何工具名。';
const NOTICE_MARKER = '【历史恢复提示】';

const USER_WORDS = '请把工作目录里的三页会议纪要整理成一份周报，写到 weekly-report.md';

describe('GoalTracker recovery-notice cleanup', () => {
  it.each([
    ['legacy', LEGACY_NOTICE],
    ['current', CURRENT_NOTICE],
  ])('strips the %s notice prefix and keeps only the user words', (_label, notice) => {
    const tracker = new GoalTracker();
    tracker.initialize(`${notice}\n\n${USER_WORDS}`);

    expect(tracker.isInitialized()).toBe(true);
    const goal = tracker.getGoalSummary().goal;
    expect(goal).toBe(USER_WORDS);
    expect(goal).not.toContain(NOTICE_MARKER);

    const checkpoint = tracker.getGoalCheckpoint(3);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint).toContain(`原始目标: ${USER_WORDS}`);
    expect(checkpoint).not.toContain(NOTICE_MARKER);
  });

  it('treats a truncated notice leftover as no content', () => {
    const tracker = new GoalTracker();
    tracker.initialize('【历史恢复提示】这条用户消息是根据 App 的运行记录还原的，措辞');
    expect(tracker.isInitialized()).toBe(false);
    expect(tracker.getGoalSummary().goal).toBe('');
    expect(tracker.getGoalCheckpoint(3)).toBeNull();
  });

  it('resets a previously initialized tracker when re-initialized with residue', () => {
    const tracker = new GoalTracker();
    tracker.initialize(USER_WORDS);
    expect(tracker.isInitialized()).toBe(true);
    tracker.initialize('【历史恢复提示】原始 user 消息缺失；以下内容');
    expect(tracker.isInitialized()).toBe(false);
    expect(tracker.getGoalSummary().goal).toBe('');
    expect(tracker.getGoalCheckpoint(3)).toBeNull();
  });

  it('leaves the tracker uninitialized on empty input', () => {
    const tracker = new GoalTracker();
    tracker.initialize('   ');
    expect(tracker.isInitialized()).toBe(false);
    expect(tracker.getGoalCheckpoint(3)).toBeNull();
  });

  it('keeps first-sentence extraction for ordinary messages', () => {
    const tracker = new GoalTracker();
    tracker.initialize('帮我整理会议纪要。然后再写一份周报。');
    expect(tracker.getGoalSummary().goal).toBe('帮我整理会议纪要。');
  });

  it('does not treat URL dots as sentence ends', () => {
    const tracker = new GoalTracker();
    tracker.initialize('整理一下 https://www.xiaohongshu.com/explore/abc 的内容。再写周报。');
    expect(tracker.getGoalSummary().goal).toBe('整理一下 https://www.xiaohongshu.com/explore/abc 的内容。');
  });

  it('truncates goals to 100 chars with ellipsis', () => {
    const tracker = new GoalTracker();
    const longMessage = `请${'做'.repeat(200)}`;
    tracker.initialize(longMessage);
    const goal = tracker.getGoalSummary().goal;
    expect(goal).toHaveLength(103);
    expect(goal.endsWith('...')).toBe(true);
    expect(goal.slice(0, 100)).toBe(longMessage.slice(0, 100));
  });
});

describe('max-steps wrap-up goal line', () => {
  it('shows only the user words after 原始目标：when the run message carried the notice', async () => {
    const goalTracker = new GoalTracker();
    goalTracker.initialize(`${LEGACY_NOTICE}\n\n${USER_WORDS}`);

    const ctx = {
      maxIterations: 4,
      workingDirectory: '/workspace/project',
      control: ControlState.forTest({}),
      stats: { runStartTime: 100 },
      messages: [],
      circuitBreaker: { isTripped: () => false },
      goalTracker,
      nudgeManager: { getModifiedFilesSince: () => [] },
      onEvent: vi.fn(),
    } as unknown as RuntimeContext;

    activateMaxStepsFinalResponse(ctx);
    const persist = vi.fn();
    await ensureMaxStepsWrapUp(ctx, { generateId: () => 'fallback', addAndPersistMessage: persist }, 4);

    const text = persist.mock.calls[0][0].content as string;
    expect(text).toContain(`原始目标：${USER_WORDS}`);
    expect(text).not.toContain(NOTICE_MARKER);
  });
});
