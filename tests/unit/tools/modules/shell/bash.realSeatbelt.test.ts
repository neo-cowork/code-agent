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
import * as approvedRmGrantModule from '../../../../../src/host/tools/shell/approvedRmGrant';
import { getTaskOutput } from '../../../../../src/host/tools/shell/backgroundTasks';
import { SANDBOX_APPROVED_RM_STILL_DENIED_FAILURE_CODE } from '../../../../../src/shared/constants';
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
  const listed = spawnSync('/bin/ls', ['-ln', target], { encoding: 'utf8' });
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
    vi.restoreAllMocks();
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
    ['sub-agent', 'second-non-workspace', () => outsideRoot],
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
    const target = join(slashTmpRoot, 'protocol-subagent.txt');
    traceApprovalGrants('parent-bridge-child');
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
          executionTopology: 'async_agent',
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

  function traceApprovalGrants(label: string): void {
    const original = approvedRmGrantModule.approvedSingleFileRmGrantForToolApproval;
    vi.spyOn(approvedRmGrantModule, 'approvedSingleFileRmGrantForToolApproval').mockImplementation((input) => {
      const grant = original(input);
      console.log(`TOOL_APPROVAL_GRANT ${label} source=${input.approvalSource} command=${input.params.command} grant=${String(grant)}`);
      return grant;
    });
  }

  it.each(['main-agent', 'sub-agent'] as const)(
    'approved two-file rm deletes both files with real seatbelt via %s', async (shape) => {
      const targets = [join(slashTmpRoot, `${shape}-two-cache.tmp`), join(outsideRoot, `${shape}-two-cache.tmp`)];
      const neighbors = [join(slashTmpRoot, `${shape}-keep.tmp`), join(outsideRoot, `${shape}-keep.tmp`)];
      [...targets, ...neighbors].forEach(file => writeFileSync(file, 'cache'));
      const requests: PermissionRequestData[] = [];
      const grant = vi.spyOn(approvedRmGrantModule, 'approvedSingleFileRmGrantForToolApproval');
      const result = await executorFor(shape, requests, true).execute(
        'Bash', { command: `rm -f -- ${targets.map(shellQuote).join(' ')}; echo "rm_exit=$?"` },
        { sessionId: `real-seatbelt-two-${shape}` },
      );
      console.log(`TWO_FILE_SEATBELT ${shape} output=${JSON.stringify(result.result)} sandbox=${JSON.stringify(result.metadata?.sandbox)} ls=${targets.map(rawLs).join('; ')}`);
      expect(grant).toHaveBeenCalledOnce();
      expect(grant.mock.results[0].value).toHaveLength(2);
      expect(requests).toHaveLength(1);
      expect(result.success, result.error).toBe(true);
      expect(result.result).toContain('rm_exit=0');
      expect(result.metadata?.sandbox).toMatchObject({ applied: true, code: 'OS_SANDBOX_APPLIED' });
      expect(targets.map(existsSync)).toEqual([false, false]);
      expect(neighbors.map(existsSync)).toEqual([true, true]);
    },
  );

  it('approved static assignment and probe script deletes both files with real seatbelt', async () => {
    const targets = [join(slashTmpRoot, 'assigned cache.tmp'), join(outsideRoot, 'assigned cache.tmp')];
    const neighbor = join(outsideRoot, 'assigned-keep.tmp');
    [...targets, neighbor].forEach(file => writeFileSync(file, 'cache'));
    const command = `F1=${shellQuote(targets[0])}; F2=${shellQuote(targets[1])}
      test -f "$F1" && echo "before $F1"; [ -f "$F2" ] && ls -l "$F2"
      stat "$F1"; rm -f -- "$F1" "$F2"; printf "rm_exit=%s" "$?"
      test ! -e "$F1" && test ! -e "$F2" && echo removed`;
    const requests: PermissionRequestData[] = [];
    const grant = vi.spyOn(approvedRmGrantModule, 'approvedSingleFileRmGrantForToolApproval');
    const result = await executorFor('main-agent', requests, true).execute(
      'Bash', { command }, { sessionId: 'real-seatbelt-assigned-probes' },
    );
    console.log(`ASSIGNMENT_PROBE_SEATBELT output=${JSON.stringify(result.result)} sandbox=${JSON.stringify(result.metadata?.sandbox)} ls=${targets.map(rawLs).join('; ')}`);
    expect(result.success, result.error).toBe(true);
    expect(grant).toHaveBeenCalledOnce();
    expect(grant.mock.results[0].value).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(result.result).toContain('rm_exit=0');
    expect(result.result).toContain('removed');
    expect(result.metadata?.sandbox).toMatchObject({ applied: true, code: 'OS_SANDBOX_APPLIED' });
    expect(targets.map(existsSync)).toEqual([false, false]);
    expect(existsSync(neighbor)).toBe(true);
  });

  it('approved natural-1 descriptor duplication deletes its absolute file under real seatbelt', async () => {
    const target = join(slashTmpRoot, 'natural-one.tmp'); writeFileSync(target, 'cache');
    const requests: PermissionRequestData[] = [];
    const grant = vi.spyOn(approvedRmGrantModule, 'approvedSingleFileRmGrantForToolApproval');
    const result = await executorFor('main-agent', requests, true).execute(
      'Bash', { command: `rm -- "${target}" 2>&1; echo "---exit:$?---"` }, { sessionId: 'real-seatbelt-natural-one' },
    );
    console.log(`NATURAL_ONE_SEATBELT output=${JSON.stringify(result.result)} sandbox=${JSON.stringify(result.metadata?.sandbox)} ls=${rawLs(target)}`);
    expect(result.success, result.error).toBe(true);
    expect(result.result).toContain('---exit:0---');
    expect(grant).toHaveBeenCalledOnce(); expect(grant.mock.results[0].value).toBeTruthy();
    expect(requests).toHaveLength(1); expect(existsSync(target)).toBe(false);
    expect(result.metadata?.sandbox).toMatchObject({ applied: true, code: 'OS_SANDBOX_APPLIED' });
  });

  it('approved natural-2 multi-rm with echo and ls probes deletes both files under real seatbelt', async () => {
    const targets = [join(slashTmpRoot, 'natural-two.tmp'), join(outsideRoot, 'natural-two.tmp')];
    const neighbor = join(outsideRoot, 'natural-two-keep.tmp');
    [...targets, neighbor].forEach(file => writeFileSync(file, 'cache'));
    const command = `rm -f -- "${targets[0]}"; echo "rm1_exit:$?"; rm -f -- "${targets[1]}"; echo "rm2_exit:$?"; echo "=== verify ==="; ls -ld -- "${targets[0]}"; echo "ls1_exit:$?"; ls -ld -- "${targets[1]}"; echo "ls2_exit:$?"`;
    const requests: PermissionRequestData[] = [];
    const grant = vi.spyOn(approvedRmGrantModule, 'approvedSingleFileRmGrantForToolApproval');
    const result = await executorFor('main-agent', requests, true).execute('Bash', { command }, { sessionId: 'real-seatbelt-natural-two' });
    console.log(`NATURAL_TWO_SEATBELT output=${JSON.stringify(result.result)} sandbox=${JSON.stringify(result.metadata?.sandbox)} ls=${targets.map(rawLs).join('; ')}`);
    expect(result.success, result.error).toBe(true);
    expect(result.result).toContain('rm1_exit:0'); expect(result.result).toContain('rm2_exit:0');
    expect(grant).toHaveBeenCalledOnce(); expect(grant.mock.results[0].value).toHaveLength(2);
    expect(requests).toHaveLength(1); expect(targets.map(existsSync)).toEqual([false, false]);
    expect(existsSync(neighbor)).toBe(true);
    expect(result.metadata?.sandbox).toMatchObject({ applied: true, code: 'OS_SANDBOX_APPLIED' });
  });

  it('approved two-file background rm deletes both files with real seatbelt in an attended session', async () => {
    const targets = [join(slashTmpRoot, 'background-cache.tmp'), join(outsideRoot, 'background-cache.tmp')];
    const neighbors = [join(slashTmpRoot, 'background-keep.tmp'), join(outsideRoot, 'background-keep.tmp')];
    [...targets, ...neighbors].forEach(file => writeFileSync(file, 'cache'));
    const requests: PermissionRequestData[] = [];
    const grant = vi.spyOn(approvedRmGrantModule, 'approvedSingleFileRmGrantForToolApproval');
    const result = await executorFor('main-agent', requests, true).execute(
      'Bash', { command: `rm -f -- ${targets.map(shellQuote).join(' ')}; echo "rm_exit=$?"`, run_in_background: true },
      { sessionId: 'real-seatbelt-approved-background-two' },
    );
    expect(result.success, result.error).toBe(true);
    const taskId = result.metadata?.taskId;
    expect(typeof taskId).toBe('string');
    const output = await getTaskOutput(String(taskId), true, 5000);
    console.log(`TWO_FILE_BACKGROUND_SEATBELT output=${JSON.stringify(output)} sandbox=${JSON.stringify(result.metadata?.sandbox)} ls=${targets.map(rawLs).join('; ')}`);
    expect(output?.exitCode).toBe(0);
    expect(output?.output).toContain('rm_exit=0');
    expect(grant).toHaveBeenCalledOnce();
    expect(grant.mock.results[0].value).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(result.metadata?.sandbox).toMatchObject({ applied: true, code: 'OS_SANDBOX_APPLIED' });
    expect(targets.map(existsSync)).toEqual([false, false]);
    expect(neighbors.map(existsSync)).toEqual([true, true]);
  });

  it.each(['; echo "exit=$?"', ' && echo done'])(
    'public Bash entry after user approval deletes an outside file with suffix %s', async (suffix) => {
      const target = join(slashTmpRoot, 'compound.txt');
      const neighbor = join(slashTmpRoot, 'neighbor.txt');
      writeFileSync(target, 'remove me');
      writeFileSync(neighbor, 'keep me');
      const command = `rm ${shellQuote(target)}${suffix}`;
      traceApprovalGrants('public-bash-compound');
      const requests: PermissionRequestData[] = [];
      const handler = await bashModule.createHandler();
      const execute = vi.spyOn(Object.getPrototypeOf(handler) as typeof handler, 'execute');
      console.log(`COMPOUND_LS_BEFORE: ${rawLs(target)}`);
      try {
        const result = await executorFor('main-agent', requests, true).execute(
          'Bash', { command }, { sessionId: 'real-seatbelt-compound' },
        );
        console.log(`COMPOUND_LS_AFTER: ${rawLs(target)}`);
        console.log(`COMPOUND_RESULT command=${command} success=${result.success} output=${JSON.stringify(result.result)} sandbox=${JSON.stringify(result.metadata?.sandbox)} failureCode=${String(result.metadata?.failureCode)} neighbor.exists=${existsSync(neighbor)}`);
        expect(execute).toHaveBeenCalledOnce();
        expect(requests).toHaveLength(1);
        expect(result.success, result.error).toBe(true);
        expect(result.metadata?.sandbox).toMatchObject({ applied: true, code: 'OS_SANDBOX_APPLIED' });
        expect(result.metadata?.failureCode).not.toBe(SANDBOX_APPROVED_RM_STILL_DENIED_FAILURE_CODE);
        expect(result.result).toContain(suffix.startsWith(';') ? 'exit=0' : 'done');
        expect(existsSync(target)).toBe(false);
        expect(existsSync(neighbor)).toBe(true);
      } finally {
        execute.mockRestore();
      }
    },
  );

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
