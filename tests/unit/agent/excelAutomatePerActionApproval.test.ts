// N-FIX-EXCEL-READ-APPROVAL-PER-CALL：ExcelAutomate 按 action 分档审批。
// 走生产入口：createSubagentToolRuntime（子代理，真 SubagentPipeline 门）与 ToolExecutor.execute（主代理）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({ getDefinition: vi.fn(), execute: vi.fn() }));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({ getDefinition: resolverState.getDefinition, execute: resolverState.execute }),
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: l, createLogger: () => l };
});

import { getSubagentPipeline, resetSubagentPipeline } from '../../../src/host/agent/subagentPipeline';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import { getPermissionModeManager, resetPermissionModeManager, type PermissionMode } from '../../../src/host/permissions/modes';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { excelAutomateSchema } from '../../../src/host/tools/modules/excel/excelAutomate.schema';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

const WORKSPACE = '/tmp/excel-ws';
const INSIDE = `${WORKSPACE}/a.xlsx`;
const OUTSIDE = '/tmp/excel-outside-contracts/13-装修工程合同.xlsx';
const SESSION = 'session-excel-per-action';
const DEF = { ...excelAutomateSchema, requiresPermission: true };

function paramsFor(action: string, filePath: string): Record<string, unknown> {
  return action === 'generate' ? { action, output_path: filePath } : { action, file_path: filePath };
}

function subagent(mode: PermissionMode) {
  getPermissionModeManager().setSessionMode(SESSION, mode, false);
  const pipeline = getSubagentPipeline();
  const pipelineContext = pipeline.createContext(
    { name: 'helper', prompt: 'helper', tools: ['ExcelAutomate'], permissionPreset: 'development' },
    WORKSPACE,
  );
  const permissionRequest = vi.fn(async () => true);
  const runtime = createSubagentToolRuntime({
    context: {
      sessionId: SESSION, cwd: WORKSPACE,
      resolver: { getDefinition: resolverState.getDefinition },
      permission: { request: permissionRequest }, events: { emit: vi.fn() },
      abortSignal: new AbortController().signal,
    } as unknown as SubagentExecutionContext,
    sessionId: SESSION,
    effectiveMode: mode,
    identity: { agentId: 'agent-1', runId: 'run-1', parentToolUseId: 'p1' },
    allowedToolNames: new Set(['ExcelAutomate']),
    policyName: 'development',
    checkToolExecution: (request) => pipeline.checkToolExecution(pipelineContext, request),
  });
  runtime.executor.setAuditEnabled(false);
  return {
    permissionRequest,
    run: (params: Record<string, unknown>) =>
      runtime.executor.execute('ExcelAutomate', params, { sessionId: SESSION, subagentPolicy: runtime.policy }),
  };
}

function mainAgent(mode: PermissionMode) {
  getPermissionModeManager().setSessionMode(SESSION, mode, false);
  const permissionRequest = vi.fn(async () => true);
  const executor = new ToolExecutor({ requestPermission: permissionRequest, workingDirectory: WORKSPACE, permissionModeOverride: mode });
  executor.setAuditEnabled(false);
  return { permissionRequest, run: (params: Record<string, unknown>) => executor.execute('ExcelAutomate', params, { sessionId: SESSION }) };
}

describe.each([
  ['子代理 createSubagentToolRuntime', subagent],
  ['主代理 ToolExecutor.execute', mainAgent],
])('ExcelAutomate 按 action 分档审批 — %s', (_label, build) => {
  beforeEach(() => {
    resetSubagentPipeline();
    resetPermissionModeManager();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.getDefinition.mockImplementation((n: string) => (n === 'ExcelAutomate' ? DEF : undefined));
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
  });

  describe.each(['default', 'acceptEdits'] as const)('%s 档', (mode) => {
    it.each(['read', 'list_sheets', 'get_range', 'validate_formulas'])('%s 读工作区外文件：0 次审批请求', async (action) => {
      const { run, permissionRequest } = build(mode);
      const result = await run(paramsFor(action, OUTSIDE));
      expect(permissionRequest).toHaveBeenCalledTimes(0);
      expect(result.success).toBe(true);
    });

    it.each(['read', 'list_sheets', 'get_range', 'edit', 'generate'])('%s 工作区内：0 次审批请求', async (action) => {
      const { run, permissionRequest } = build(mode);
      const result = await run(paramsFor(action, INSIDE));
      expect(permissionRequest).toHaveBeenCalledTimes(0);
      expect(result.success).toBe(true);
    });

    it('automate（跑宏）：1 次审批请求', async () => {
      const { run, permissionRequest } = build(mode);
      await run({ action: 'automate', file_path: INSIDE, macro: 'Run' });
      expect(permissionRequest).toHaveBeenCalledTimes(1);
      expect(permissionRequest).toHaveBeenCalledWith(expect.objectContaining({ tool: 'ExcelAutomate' }));
    });
  });
});
