// ============================================================================
// N-FIX-DELIVERABLE-DISK-CHECK-FALSE-MISSING-DOUBLE-APPROVAL-REST1（realrun105 item 1）
// 印章管线：生产入口 ToolExecutor.execute——真人审批放行（ask.approvalSource === 'user'）
// 的成功结果 metadata 盖 userApproved: true；机器批准（session-allowlist / dev-auto-approve /
// auto-approve-level / unattended-readonly / 裸 boolean）与拒绝不盖章。
// resolver 用 mock（与 decisionTrace 同款），权限流走真链路。Evidence class: hermetic-protocol.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';

const resolverState = vi.hoisted(() => ({ getDefinition: vi.fn(), execute: vi.fn() }));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

const WRITE_TOOL_DEF = {
  name: 'Write',
  description: 'write test tool',
  inputSchema: { type: 'object', properties: {}, required: [] },
  requiresPermission: true,
  permissionLevel: 'write' as const,
};
// 家目录目标（resolver 已 mock，不真写盘）：W3 outside_project 强制 ask——/tmp 目标会被
// 分类器「写入临时目录」自动放行，根本不进审批流，测不到审批来源。
const EXTERNAL_TARGET = `${os.homedir()}/neo-stamp-probe-${process.pid}.txt`;
const EXTERNAL_WRITE_PARAMS = { file_path: EXTERNAL_TARGET, content: '# 本周周报\n\n待补充\n' };

describe('ToolExecutor userApproved metadata stamp (realrun105)', () => {
  beforeEach(() => {
    resetDecisionHistory();
    resetPermissionModeManager();
    getToolCache().clear();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.getDefinition.mockReturnValue(WRITE_TOOL_DEF);
    resolverState.execute.mockResolvedValue({
      success: true,
      result: 'ok',
      outputPath: EXTERNAL_TARGET,
      metadata: { outputPath: EXTERNAL_TARGET },
    });
  });

  let caseId = 0;
  const executeWith = async (
    requestPermission: ConstructorParameters<typeof ToolExecutor>[0]['requestPermission'],
  ) => {
    caseId += 1;
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    executor.setAuditEnabled(false);
    // 每例独立 sessionId：真人批准会学进会话级授权，共用 sessionId 会污染后续用例。
    return executor.execute('Write', EXTERNAL_WRITE_PARAMS, { sessionId: `stamp-case-${caseId}` });
  };

  it('真人审批放行（approvalSource: user）→ 成功结果 metadata 盖 userApproved: true，既有 metadata 保留', async () => {
    const result = await executeWith(vi.fn().mockResolvedValue({ approved: true, approvalSource: 'user' }));

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      userApproved: true,
      outputPath: EXTERNAL_TARGET,
      executionStarted: true,
    });
  });

  it.each(['session-allowlist', 'dev-auto-approve', 'auto-approve-level', 'unattended-readonly', undefined])(
    '机器批准 %s 不盖章（metadata 无 userApproved）',
    async (approvalSource) => {
      const result = await executeWith(vi.fn().mockResolvedValue({ approved: true, approvalSource }));

      expect(result.success).toBe(true);
      expect(result.metadata?.userApproved).toBeUndefined();
      expect(result.metadata?.outputPath).toBe(EXTERNAL_TARGET);
    },
  );

  it('裸 boolean true（无自报来源的 blanket 放行）不盖章', async () => {
    const result = await executeWith(vi.fn().mockResolvedValue(true));

    expect(result.success).toBe(true);
    expect(result.metadata?.userApproved).toBeUndefined();
  });

  it('拒绝不盖章', async () => {
    const result = await executeWith(vi.fn().mockResolvedValue({ approved: false, denialSource: 'user' }));

    expect(result.success).toBe(false);
    expect(result.metadata?.userApproved).toBeUndefined();
  });

  it('免审批直通（requiresPermission 不触发审批流）不盖章', async () => {
    resolverState.getDefinition.mockReturnValue({
      ...WRITE_TOOL_DEF,
      requiresPermission: false,
    });
    const result = await executeWith(vi.fn());

    expect(result.success).toBe(true);
    expect(result.metadata?.userApproved).toBeUndefined();
  });
});
