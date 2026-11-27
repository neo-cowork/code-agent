// ============================================================================
// N-PERM-NL-RULES-K2 ④：preapprove（「只有我说了 X 才做」）命中触发短语，也不得越过
// 内置的危险命令硬拒（chmod 777 / kill -1 这类）。规则只能免掉「问一下」，不能放宽内置闸。
//
// 真实 ToolExecutor + 真实 PolicyEngine + 真实权限岛；工具派发边界（toolResolver.execute）
// mock 掉——这里的命令绝不真跑，断言的是「有没有走到派发」。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

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

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({ callTool: vi.fn(), getTools: () => [] }),
}));

import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { beginRunPolicy, endRunPolicy } from '../../../src/host/permissions/runPolicySnapshot';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getExecPolicyStore, resetExecPolicyStore } from '../../../src/host/security/execPolicy';
import { getDecisionHistory } from '../../../src/host/security/decisionHistory';
import type { AppSettings } from '../../../src/shared/contract';

const SESSION = 'k2-preapprove-builtin-deny-session';
const RUN_ID = 'k2-preapprove-builtin-deny-run';
const PHRASE = '按我说的改';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

function makeIsland(): OrchestratorPermissionIsland {
  return new OrchestratorPermissionIsland({
    getSettings: settings,
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'main',
    hasApprovalUi: () => false,
    onEvent: vi.fn(),
  });
}

function makeExecutor(island: OrchestratorPermissionIsland): ToolExecutor {
  return new ToolExecutor({
    requestPermission: (request) => island.requestPermission(request),
    workingDirectory: '/tmp/workbench',
  });
}

function isStillPending<T>(promise: Promise<T>): Promise<boolean> {
  const pending = Symbol('pending');
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(pending), 300))])
    .then((result) => result === pending);
}

beforeEach(() => {
  resetPolicyEngine();
  resetExecPolicyStore();
  resetPermissionModeManager();
  resolverState.getDefinition.mockReset();
  resolverState.execute.mockReset();
  resolverState.getDefinition.mockReturnValue({
    name: 'Bash',
    description: 'run a shell command',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: true,
    permissionLevel: 'execute' as const,
    readOnly: false,
  });
  resolverState.execute.mockResolvedValue({ success: true, output: 'ran' });
});

afterEach(() => {
  endRunPolicy(RUN_ID);
  resetPermissionModeManager();
  resetPolicyEngine();
  vi.restoreAllMocks();
});

describe('④ preapprove 命中短语也越不过内置危险命令硬拒', () => {
  it.each([
    ['chmod 777 note.txt', 'Bash(chmod *)'],
    ['kill -1', 'Bash(kill *)'],
  ])('对照：没有规则时 `%s` 被内置硬拒，不执行、不出卡', async (command) => {
    beginRunPolicy(RUN_ID, SESSION, { roleId: undefined, initiatingText: `${PHRASE}，动手吧` });
    const island = makeIsland();

    const result = await makeExecutor(island).execute('Bash', { command }, { sessionId: SESSION });

    expect(result.success).toBe(false);
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(island.listPendingRequests()).toHaveLength(0);
  });

  it.each([
    ['chmod 777 note.txt', 'Bash(chmod *)'],
    ['kill -1', 'Bash(kill *)'],
  ])('preapprove 规则命中短语：`%s` 仍被内置硬拒，不执行', async (command, rule) => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule, phrases: [PHRASE] }] });
    beginRunPolicy(RUN_ID, SESSION, { roleId: undefined, initiatingText: `${PHRASE}，动手吧` });
    const island = makeIsland();

    const result = await makeExecutor(island).execute('Bash', { command }, { sessionId: SESSION });

    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(island.listPendingRequests()).toHaveLength(0);
  });

  it('同一条 preapprove 规则命中短语：不在内置硬拒里的命令照常免卡执行', async () => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule: 'Bash(chmod *)', phrases: [PHRASE] }] });
    beginRunPolicy(RUN_ID, SESSION, { roleId: undefined, initiatingText: `${PHRASE}，动手吧` });
    const island = makeIsland();

    const result = await makeExecutor(island).execute('Bash', { command: 'chmod 644 note.txt' }, { sessionId: SESSION });

    expect(result.success).toBe(true);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    expect(island.listPendingRequests()).toHaveLength(0);
  });

  it('同一条 preapprove 规则没说短语：不在内置硬拒里的命令出卡，不静默放行', async () => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule: 'Bash(chmod *)', phrases: [PHRASE] }] });
    beginRunPolicy(RUN_ID, SESSION, { roleId: undefined, initiatingText: '整理一下文件' });
    const island = makeIsland();

    const resultPromise = makeExecutor(island).execute('Bash', { command: 'chmod 644 note.txt' }, { sessionId: SESSION });

    expect(await isStillPending(resultPromise)).toBe(true);
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(island.listPendingRequests()).toHaveLength(1);
    island.handlePermissionResponse(island.listPendingRequests()[0].id, 'deny');
    await resultPromise;
  });
});

describe('NL preapproval respects exec policy', () => {
  const command = 'chmod 644 note.txt';

  function prepare(decision: 'forbidden' | 'prompt') {
    getExecPolicyStore().addRule(command.split(' '), decision);
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule: 'Bash(chmod *)', phrases: [PHRASE] }] });
    beginRunPolicy(RUN_ID, SESSION, { initiatingText: PHRASE });
    const island = makeIsland();
    return { island, execution: makeExecutor(island).execute('Bash', { command }, { sessionId: SESSION, runId: RUN_ID }) };
  }

  it('forbidden denies dispatch even after the user said the trigger phrase', async () => {
    const { island, execution } = prepare('forbidden');
    expect(await execution).toMatchObject({ success: false, error: expect.stringContaining('Blocked by exec policy') });
    expect(getDecisionHistory().getRecent(1)[0]).toMatchObject({ outcome: 'policy-deny', reason: 'exec-policy' });
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(island.listPendingRequests()).toHaveLength(0);
  });

  it('prompt shows the normal approval even after the user said the trigger phrase', async () => {
    const { island, execution } = prepare('prompt');
    const approval = await Promise.race([
      execution.then(() => undefined),
      new Promise<ReturnType<typeof island.listPendingRequests>[number] | undefined>((resolve) => {
        setTimeout(() => resolve(island.listPendingRequests()[0]), 300);
      }),
    ]);
    expect(approval).toBeDefined();
    expect(resolverState.execute).not.toHaveBeenCalled();
    if (approval) island.handlePermissionResponse(approval.id, 'deny');
    await execution;
  });
});
