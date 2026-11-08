import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: () => Promise.resolve(null),
}));

import { getPermissionModeManager, resetPermissionModeManager } from '../../../../../src/host/permissions/modes';
import { getPolicyEngine, resetPolicyEngine } from '../../../../../src/host/permissions/policyEngine';
import { getSandboxManager } from '../../../../../src/host/sandbox';
import { getToolCache } from '../../../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../../../src/host/tools/protocolRegistry';
import { bashModule } from '../../../../../src/host/tools/modules/shell/bash';
import { ToolExecutor } from '../../../../../src/host/tools/toolExecutor';
import { createProtocolSubagentExecutionContext } from '../../../../../src/host/agent/subagentExecutionContext';
import {
  buildCanUseToolFromLegacy,
  buildProtocolContext,
} from '../../../../../src/host/tools/dispatch/shadowAdapter';
import { getToolResolver } from '../../../../../src/host/tools/dispatch/toolResolver';
import { getToolLedgerSink } from '../../../../../src/host/tools/toolLedgerSink';
import type { PermissionRequestData } from '../../../../../src/host/tools/types';
import type { CanUseToolFn, ToolContext } from '../../../../../src/host/protocol/tools';
import { buildRuleString } from '../../../../../src/shared/permissionRuleTranslate';

const sandboxReady = process.platform === 'darwin' && getSandboxManager().isAvailable();
const suite = sandboxReady ? describe : describe.skip;
const ASK_RULE = buildRuleString({ tool: 'Bash', pattern: 'rm *' });

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function rawLs(target: string): string {
  const listed = spawnSync('/bin/ls', ['-l', target], { encoding: 'utf8' });
  return `${listed.stdout}${listed.stderr}`.trim();
}

suite('approved rm uses a real seatbelt literal grant', () => {
  let workspace: string;
  let slashTmpRoot: string;
  let osTmpRoot: string;
  let outsideRoot: string;
  const originalSandboxEnv = process.env.OS_SANDBOX_ENABLED;

  beforeAll(() => {
    getProtocolRegistry();
    process.env.OS_SANDBOX_ENABLED = 'true';
    workspace = mkdtempSync(join(tmpdir(), 'neo-rm-seatbelt-workspace-'));
    slashTmpRoot = mkdtempSync('/tmp/neo-rm-seatbelt-slash-tmp-');
    osTmpRoot = mkdtempSync(join(tmpdir(), 'neo-rm-seatbelt-os-tmp-'));
    outsideRoot = mkdtempSync(join(homedir(), '.neo-rm-seatbelt-outside-'));
  });

  beforeEach(() => {
    resetPolicyEngine();
    resetPermissionModeManager();
    getPermissionModeManager().setMode('default', true);
    getPolicyEngine().loadUserRules({ ask: [ASK_RULE] }, 'user-ui');
    getToolCache().clear();
  });

  afterEach(() => {
    resetPolicyEngine();
    resetPermissionModeManager();
  });

  afterAll(() => {
    if (originalSandboxEnv === undefined) delete process.env.OS_SANDBOX_ENABLED;
    else process.env.OS_SANDBOX_ENABLED = originalSandboxEnv;
    for (const directory of [workspace, slashTmpRoot, osTmpRoot, outsideRoot]) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function executorFor(
    shape: 'main-agent' | 'sub-agent',
    requests: PermissionRequestData[],
    approved: boolean,
  ): ToolExecutor {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      executionTopology: shape === 'sub-agent' ? 'async_agent' : 'main',
      ledgerOrigin: 'eval',
      requestPermission: async (request) => {
        requests.push(request);
        return approved
          ? { approved: true, approvalSource: 'user' as const }
          : { approved: false, denialSource: 'user' as const };
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  it.each([
    ['main-agent', 'slash-tmp', () => slashTmpRoot],
    ['main-agent', 'second-non-workspace', () => outsideRoot],
  ] as const)('approve -> %s deletes one file in %s', async (shape, location, root) => {
    const target = join(root(), `${shape}-${location}.txt`);
    writeFileSync(target, 'remove me');
    const requests: PermissionRequestData[] = [];
    const result = await executorFor(shape, requests, true).execute(
      'Bash',
      { command: `rm ${shellQuote(target)}` },
      {
        sessionId: `real-seatbelt-approved-${shape}-${location}`,
        ...(shape === 'sub-agent'
          ? { agentId: 'coder-real-seatbelt', spawnDepth: 1, spawnTreeId: 'tree-real-seatbelt' }
          : {}),
      },
    );

    console.log(`REAL_SEATBELT_AFTER_APPROVE ${shape}/${location}: ${rawLs(target)}`);
    expect(result.success, result.error).toBe(true);
    expect(requests).toHaveLength(1);
    expect(existsSync(target)).toBe(false);
  });

  it('real parent protocol bridge -> child approval grants the first sandboxed rm and one ledger row', async () => {
    const target = join(outsideRoot, 'protocol-subagent.txt');
    const parentProbe = join(workspace, 'parent-protocol-probe.txt');
    writeFileSync(target, 'remove me');
    writeFileSync(parentProbe, 'parent probe');
    const requests: PermissionRequestData[] = [];
    const appendPermissionDecision = vi.spyOn(getToolLedgerSink(), 'appendPermissionDecision');

    const parentExecutor = new ToolExecutor({
      workingDirectory: workspace,
      ledgerOrigin: 'eval',
      requestPermission: async (request) => {
        requests.push(request);
        return { approved: true, approvalSource: 'user' as const };
      },
      dispatchTool: async (_toolName, _params, legacyContext) => {
        const parentContext = legacyContext;
        parentContext.modelConfig = { provider: 'mock', model: 'mock-model' };
        parentContext.resolver = getToolResolver();
        const protocolContext = buildProtocolContext({
          sessionId: 'real-seatbelt-parent-session',
          workingDirectory: workspace,
          legacyCtx: parentContext,
          resolver: getToolResolver(),
        });
        const subagentContext = createProtocolSubagentExecutionContext(
          protocolContext,
          buildCanUseToolFromLegacy(parentContext, 'spawn_agent'),
        );
        const childExecutor = new ToolExecutor({
          workingDirectory: workspace,
          ledgerOrigin: 'subagent',
          forcePermissionHandler: true,
          requestPermission: (request) => subagentContext.permission.request(request),
        });
        childExecutor.setAuditEnabled(false);
        return childExecutor.execute('Bash', { command: `rm ${shellQuote(target)}` }, {
          sessionId: 'real-seatbelt-child-session',
          agentId: 'coder-real-seatbelt',
          spawnDepth: 1,
          spawnTreeId: 'tree-real-seatbelt-protocol',
        });
      },
    });
    parentExecutor.setAuditEnabled(false);

    try {
      const result = await parentExecutor.execute(
        'ListDirectory',
        { path: workspace },
        { sessionId: 'real-seatbelt-parent-session', currentToolCallId: 'real-seatbelt-parent-call' },
      );

      console.log(`REAL_SEATBELT_PROTOCOL_SUBAGENT_AFTER_APPROVE: ${rawLs(target)}`);
      expect(result.success, result.error).toBe(true);
      expect(requests.filter((request) => request.tool.toLowerCase() === 'bash')).toHaveLength(1);
      expect(existsSync(target)).toBe(false);
      expect(appendPermissionDecision.mock.calls.filter(([row]) => (
        row as { historyOutcome?: string }
      ).historyOutcome === 'ask-approved' && (row as { toolName?: string }).toolName?.toLowerCase() === 'bash')).toHaveLength(1);
    } finally {
      appendPermissionDecision.mockRestore();
    }
  });

  it('public Bash entry deletes the approved file under os.tmpdir with the real sandbox', async () => {
    const target = join(osTmpRoot, 'main-agent-os-tmpdir.txt');
    writeFileSync(target, 'remove me');
    let approvalCalls = 0;
    const approve: CanUseToolFn = async () => {
      approvalCalls += 1;
      return { allow: true };
    };
    const context = {
      sessionId: 'real-seatbelt-approved-os-tmpdir',
      workspace,
      workingDir: workspace,
      abortSignal: new AbortController().signal,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      emit: vi.fn(),
      policyEnforcer: null,
      approvedSandboxWriteFile: target,
    } as ToolContext;
    const handler = await bashModule.createHandler();
    const result = await handler.execute({ command: `rm ${shellQuote(target)}` }, context, approve);

    console.log(`REAL_SEATBELT_AFTER_APPROVE main-agent/os-tmpdir: ${rawLs(target)}`);
    expect(result.ok).toBe(true);
    expect(approvalCalls).toBe(1);
    expect(existsSync(target)).toBe(false);
  });

  it('deny -> one approval decision leaves the outside file in place', async () => {
    const target = join(outsideRoot, 'deny-keeps-file.txt');
    writeFileSync(target, 'keep me');
    const requests: PermissionRequestData[] = [];
    const result = await executorFor('main-agent', requests, false).execute(
      'Bash',
      { command: `rm ${shellQuote(target)}` },
      { sessionId: 'real-seatbelt-denied' },
    );

    console.log(`REAL_SEATBELT_AFTER_DENY: ${rawLs(target)}`);
    expect(result.success).toBe(false);
    expect(requests).toHaveLength(1);
    expect(existsSync(target)).toBe(true);
  });

  it.each(['rm -rf ..', 'rm -rf ~'])('%s stays hard-blocked and never reaches an approval card', async (command) => {
    const dangerRoot = mkdtempSync(join(tmpdir(), 'neo-rm-seatbelt-danger-'));
    const child = join(dangerRoot, 'child');
    mkdirSync(child);
    const previousHome = process.env.HOME;
    process.env.HOME = dangerRoot;
    const requests: PermissionRequestData[] = [];
    try {
      const executor = new ToolExecutor({
        workingDirectory: child,
        ledgerOrigin: 'eval',
        requestPermission: async (request) => {
          requests.push(request);
          return { approved: true, approvalSource: 'user' as const };
        },
      });
      executor.setAuditEnabled(false);
      const result = await executor.execute('Bash', { command }, { sessionId: `real-seatbelt-danger-${command}` });
      expect(result.success).toBe(false);
      expect(requests).toHaveLength(0);
      expect(existsSync(child)).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(dangerRoot, { recursive: true, force: true });
    }
  });
});
