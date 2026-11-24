// ============================================================================
// N-FIX-UX-APPROVAL-CARD-REDESIGN-FU1-READONLY-FREE-FU1 · 后台任务路径上的只读探测免卡
// 走生产入口：TaskManager 后台 run 的 AgentOrchestrator 执行器配置 + toolExecutionEngine 的 execute 选项；
// 子 agent 路径走 createSubagentToolRuntime。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getToolCache } from '../../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../../src/host/permissions/modes';
import { getPolicyEngine, resetPolicyEngine } from '../../../../src/host/permissions/policyEngine';
import { getDecisionHistory, resetDecisionHistory } from '../../../../src/host/security/decisionHistory';
import { ToolExecutor } from '../../../../src/host/tools/toolExecutor';
import { createSubagentToolRuntime } from '../../../../src/host/agent/subagentToolRuntime';
import { mintDelegatedTurnOrigin, mintUserTurnOrigin } from '../../../../src/host/agent/messageOrigin';
import type { SubagentExecutionContext } from '../../../../src/host/agent/subagentExecutorTypes';

const SESSION = 'ro-probe-bg-session';
const PROBE = 'command -v pdftotext; command -v pdfinfo; command -v mutool; command -v gs; command -v qpdf; command -v python3; command -v node';

describe('后台任务路径：只读探测免卡', () => {
  let root: string;
  let asks: string[];

  beforeAll(() => { getProtocolRegistry(); });
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ro-probe-bg-')));
    asks = [];
    getToolCache().clear();
    resetPermissionModeManager();
    resetPolicyEngine();
    resetDecisionHistory();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resetPolicyEngine();
    resetPermissionModeManager();
    await fs.rm(root, { recursive: true, force: true });
  });

  const requestPermission = async (req: unknown) => { asks.push(String((req as { details?: { command?: string } }).details?.command ?? 'ask')); return false; };
  const probeRows = () => getDecisionHistory().getAll().filter((e) => e.reason === 'readonly-probe-plan');

  // TaskManager.createOrchestrator → AgentOrchestrator 的执行器配置 + toolExecutionEngine 的 execute 选项
  function backgroundTaskRun(command: string, delegated = true, executionTopology: 'main' | 'async_agent' = 'main') {
    const ex = new ToolExecutor({ requestPermission, workingDirectory: root, ledgerOrigin: 'desktop', executionTopology });
    ex.setAuditEnabled(false);
    const ids = { sessionId: SESSION, runId: 'bg-run-1', turnId: 'turn-1' };
    return ex.execute('Bash', { command }, {
      ...ids,
      sourceMessageId: 'user-1',
      turnOrigin: delegated ? mintDelegatedTurnOrigin(ids) : mintUserTurnOrigin(ids),
      currentAttachments: [{ path: path.join(root, 'contract.pdf') }],
    } as never);
  }

  function subagentRun(command: string, executionTopology: 'main' | 'async_agent' = 'main') {
    const context = {
      runId: 'child-run-1', sessionId: SESSION, cwd: root, executionTopology,
      permission: { request: requestPermission },
      resolver: { getDefinition: () => ({ permissionLevel: 'execute' }) },
    } as unknown as SubagentExecutionContext;
    const { executor, policy } = createSubagentToolRuntime({
      context, sessionId: SESSION, effectiveMode: 'default',
      identity: { agentId: 'child-1', runId: 'child-run-1' },
      allowedToolNames: new Set(['Bash']),
      checkToolExecution: () => ({ allowed: true }),
    });
    executor.setAuditEnabled(false);
    return executor.execute('Bash', { command }, {
      runId: 'child-run-1', sessionId: SESSION, agentId: 'child-1', spawnDepth: 1,
      subagentPolicy: policy, currentAttachments: [{ path: path.join(root, 'contract.pdf') }],
    } as never);
  }

  it('background task (AgentOrchestrator executor): 7x command -v runs without a card', async () => {
    const r = await backgroundTaskRun(PROBE);
    expect(asks).toEqual([]);
    expect(r.metadata?.readonlyProbePlan).toBe(true);
    expect(probeRows().length).toBe(1);
  });

  it('sub-agent executor: 7x command -v runs without a card', async () => {
    const r = await subagentRun(PROBE);
    expect(asks).toEqual([]);
    expect(r.metadata?.readonlyProbePlan).toBe(true);
    expect(probeRows().length).toBe(1);
  });

  describe('async_agent topology (background sub-agent / unattended run)', () => {
    it('background executor: 7x command -v runs without a card', async () => {
      const r = await backgroundTaskRun(PROBE, true, 'async_agent');
      expect(asks).toEqual([]);
      expect(r.metadata?.readonlyProbePlan).toBe(true);
      expect(probeRows().length).toBe(1);
    });

    it('background sub-agent runtime: 7x command -v runs without a card', async () => {
      const r = await subagentRun(PROBE, 'async_agent');
      expect(asks).toEqual([]);
      expect(r.metadata?.readonlyProbePlan).toBe(true);
      expect(probeRows().length).toBe(1);
    });
  });

  describe('async_agent path: nothing that must be carded loses its card', () => {
    const topo = (command: string) => backgroundTaskRun(command, true, 'async_agent');

    it('a command with a write still asks (command -v x; rm -rf y)', async () => {
      const r = await topo(`command -v ls; rm -rf ${path.join(root, 'y')}`);
      expect(r.metadata?.readonlyProbePlan).toBeUndefined();
      expect(asks.length).toBe(1);
      expect(probeRows()).toEqual([]);
    });

    it('a command under a user deny rule is still denied', async () => {
      getPolicyEngine().loadUserRules({ deny: ['Bash(command -v *)'] });
      const r = await topo(PROBE);
      expect(r.success).toBe(false);
      expect(r.metadata?.readonlyProbePlan).toBeUndefined();
      expect(probeRows()).toEqual([]);
    });

    it('a user ask rule still raises the card', async () => {
      getPolicyEngine().loadUserRules({ ask: ['Bash(command -v *)'] });
      const r = await topo(PROBE);
      expect(r.metadata?.readonlyProbePlan).toBeUndefined();
      expect(asks.length).toBe(1);
      expect(probeRows()).toEqual([]);
    });

    it('reading ~/.ssh still asks', async () => {
      const r = await topo('ls -l ~/.ssh');
      expect(r.metadata?.readonlyProbePlan).toBeUndefined();
      expect(probeRows()).toEqual([]);
    });

    it('readOnly permission mode still asks', async () => {
      getPermissionModeManager().setSessionMode(SESSION, 'readOnly', true, 'external');
      const r = await topo(PROBE);
      expect(r.metadata?.readonlyProbePlan).toBeUndefined();
      expect(probeRows()).toEqual([]);
    });

    it('peer-agent origin still asks', async () => {
      const ex = new ToolExecutor({ requestPermission, workingDirectory: root, ledgerOrigin: 'desktop', executionTopology: 'async_agent' });
      ex.setAuditEnabled(false);
      const ids = { sessionId: SESSION, runId: 'bg-run-1', turnId: 'turn-1' };
      const r = await ex.execute('Bash', { command: PROBE }, { ...ids, turnOrigin: [{ senderKind: 'peer-agent', senderAgentId: 'other', ...ids }] } as never);
      expect(r.metadata?.readonlyProbePlan).toBeUndefined();
      expect(probeRows()).toEqual([]);
    });
  });
});
