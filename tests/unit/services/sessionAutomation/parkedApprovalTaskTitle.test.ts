// ============================================================================
// N-FIX-TELEMETRY-RECOVERY-NOTICE-RESIDUE-SKILLDRAFT-TITLE — 停靠审批任务名不吃恢复提示
// approvalTaskTitle 从库里最近的 user 消息派生任务名：经共用清洗入口剥掉旧恢复提示，
// 只剩提示的消息不算有效正文（继续向前找，找不到就不出任务名）。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/shared/contract';

const LEGACY_NOTICE =
  '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getSession: () => ({ id: 'sess-1', title: '[Channel] companion' }),
    getMessages: () => [
      { role: 'user', content: `${LEGACY_NOTICE}\n\n` },
      { role: 'user', content: `${LEGACY_NOTICE}\n\n整理合同并写摘要到 notes.md` },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1' }] },
    ] as unknown as Message[],
  }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { approvalTaskTitle } from '../../../../src/host/services/sessionAutomation/parkedApprovalTaskTitle';

describe('approvalTaskTitle ignores the recovery notice', () => {
  it('skips the notice-only message and names the task from the real text', () => {
    const title = approvalTaskTitle('sess-1', { toolCallId: 'call-1' });
    // deriveDelegatedSessionTitle 在句读断点（notes.md 的 `.`）处截断
    expect(title).toBe('整理合同并写摘要到 notes');
    expect(title ?? '').not.toMatch(/历史恢复提示|telemetry|重建|脱敏/);
  });
});
