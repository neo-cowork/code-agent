// ============================================================================
// 录制工作流描述的动作词只取共享表
// （N-FIX-TOOL-SUMMARY-VERB-MISMATCH-WITH-LABEL-MAP-COMBO-VERBS）
// ============================================================================
// 技能建议卡 / SKILL.md frontmatter 里的「自动录制的工作流：A → B（N 步）」原先自己
// 维护一份动词表（执行命令 / 搜索文件 / 获取网页），与审批卡、步骤摘要的说法
// （运行命令 / 查找文件 / 网页抓取）对不上，未登记的工具还直接露出原名。
// 这里走生产入口 getComboRecorder().checkSuggestion，钉住真实录制数据上的拼法，
// 不复制被测辅助函数。
// ============================================================================

import type { ToolResult } from '../../../../src/shared/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { getComboRecorder, shutdownComboRecorder } from '../../../../src/host/services/skills/comboRecorder';

const SESSION_ID = 'combo-description-session';
const UNKNOWN_TOOL = 'combo_probe_unregistered_tool';

function toolResult(toolCallId: string): ToolResult {
  return { toolCallId, success: true, output: 'ok', duration: 10 };
}

function recordTurn(userMessage: string, tools: string[], firstCallId: number): void {
  const recorder = getComboRecorder();
  recorder.markTurn(SESSION_ID, userMessage);
  tools.forEach((toolName, index) => {
    const toolCallId = `call-${firstCallId + index}`;
    recorder.recordStep(SESSION_ID, toolCallId, toolName, { query: toolName }, toolResult(toolCallId));
  });
}

afterEach(() => {
  shutdownComboRecorder();
});

describe('ComboRecorder 录制描述', () => {
  it('动作词取共享表：运行命令 / 查找文件 / 网页抓取 / 读取文件，未登记工具不露原名', () => {
    getComboRecorder().startRecording(SESSION_ID);
    recordTurn('找出所有测试文件', ['bash', 'glob'], 1);
    recordTurn('读一个文件，再抓一页网页', ['web_fetch', 'read_file', UNKNOWN_TOOL], 3);

    const suggestion = getComboRecorder().checkSuggestion(SESSION_ID);
    const description = suggestion?.suggestedDescription ?? '';

    expect(description).toBe('自动录制的工作流：运行命令 → 查找文件 → 网页抓取 → 读取文件 → 操作（5 步）');
    for (const verb of ['运行命令', '查找文件', '网页抓取', '读取文件']) {
      expect(description).toContain(verb);
    }
    for (const stale of ['执行命令', '搜索文件', '获取网页', UNKNOWN_TOOL]) {
      expect(description).not.toContain(stale);
    }
  });

  it('映射之后再去重：别名工具、未登记工具各只出现一次，保持首次出现的顺序', () => {
    getComboRecorder().startRecording(SESSION_ID);
    recordTurn('读两份文件', ['read', 'read_file'], 1);
    recordTurn('换个工具再读一遍', ['Read', UNKNOWN_TOOL, 'another_unregistered_probe', 'read_file'], 3);

    const suggestion = getComboRecorder().checkSuggestion(SESSION_ID);
    const description = suggestion?.suggestedDescription ?? '';

    expect(description).toBe('自动录制的工作流：读取文件 → 操作（6 步）');
    expect(description).not.toContain('读取文件 → 读取文件');
    expect(description).not.toContain('操作 → 操作');
    for (const raw of ['read', 'Read', 'read_file', UNKNOWN_TOOL, 'another_unregistered_probe']) {
      expect(description).not.toContain(raw);
    }
    // 步数照旧数每一步，不随去重变少
    expect(suggestion?.stepCount).toBe(6);
  });
});
