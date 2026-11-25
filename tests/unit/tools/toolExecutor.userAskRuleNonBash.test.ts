// N-FIX-USER-ASK-RULE-NON-BASH-TOOLS-NOT-ENFORCED：用户保存的 ask 规则对每个工具都要进审批，
// 不只 Bash。规则串用 buildRuleString，经 loadUserRules 装载。Read/Glob 是 read 档
// （requiresPermission 为 false），必须靠 guardFabricAskRuleOnly 进入审批块。

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.unmock('better-sqlite3');

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: vi.fn(() => loggerMock),
  logger: loggerMock,
  default: loggerMock,
}));

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { evaluateGuardFabricGate } from '../../../src/host/tools/guardFabricGate';
import { getAllToolDefinitions } from '../../../src/host/tools/dispatch/toolDefinitions';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { normalizeToolName } from '../../../src/host/tools/toolNames';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import { validateUserPermissionRule } from '../../../src/shared/permissionRuleSyntax';
import { buildRuleString } from '../../../src/shared/permissionRuleTranslate';
import type { AppSettings } from '../../../src/shared/contract';

const READ_RULE = buildRuleString({ tool: 'Read' });
const GLOB_RULE = buildRuleString({ tool: 'Glob' });
const WRITE_RULE = buildRuleString({ tool: 'Write' });
const WEB_FETCH_RULE = buildRuleString({ tool: 'web_fetch' });
const BASH_RM_RULE = buildRuleString({ tool: 'Bash', pattern: 'rm *' });
const MARKER = 'ask-rule-notes-marker';

describe('用户 ask 规则覆盖非 Bash 工具', () => {
  let dir: string;
  let notePath: string;
  let requests: PermissionRequestData[];

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join('/tmp', 'ask-rule-nonbash-'));
    notePath = path.join(dir, 'notes.txt');
    await fs.writeFile(notePath, `${MARKER}\n周一例会：范围锁定。\n`);
    requests = [];
    loggerMock.info.mockClear();
    resetPolicyEngine();
    resetPermissionModeManager();
    getToolCache().clear();
    getPolicyEngine().loadUserRules({ ask: [READ_RULE] }, 'user-ui');
  });

  afterEach(async () => {
    resetPolicyEngine();
    resetPermissionModeManager();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const makeExecutor = (answer: boolean) => {
    const executor = new ToolExecutor({
      workingDirectory: dir,
      requestPermission: async (request) => {
        requests.push(request);
        return answer;
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  };

  const bodyOf = (result: { output?: unknown; result?: unknown }): string => String(result.output ?? result.result ?? '');

  it('ask 规则串是裸工具名', () => {
    expect(READ_RULE).toBe('Read');
    expect(GLOB_RULE).toBe('Glob');
    expect(WRITE_RULE).toBe('Write');
    expect(WEB_FETCH_RULE).toBe('web_fetch');
    expect(BASH_RM_RULE).toBe('Bash(rm *)');
  });

  it('Read：批准只读一次，下一次相同调用再问', async () => {
    const executor = makeExecutor(true);
    const first = await executor.execute('Read', { file_path: notePath }, { sessionId: 'ask-read-1' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tool).toBe('Read');
    expect(requests[0]?.forceConfirm).toBe(true);
    expect(first.success).toBe(true);
    expect(bodyOf(first)).toContain(MARKER);
    const hit = loggerMock.info.mock.calls.find((call) => call[0] === 'User ask rule hit, forcing approval');
    expect(hit?.[1]).toMatchObject({ toolName: 'Read', rule: 'user-prompt-Read' });
    process.stdout.write(`ask-rule log: ${JSON.stringify(hit)}\n`);

    requests.length = 0;
    const second = await executor.execute('Read', { file_path: notePath }, { sessionId: 'ask-read-1' });
    expect(requests).toHaveLength(1);
    expect(second.success).toBe(true);
    expect(bodyOf(second)).toContain(MARKER);
  });

  it.each([
    ['default'],
    ['acceptEdits'],
    ['bypassPermissions'],
  ] as const)('Read 在 %s 档仍要审批', async (mode) => {
    const modes = getPermissionModeManager();
    const previous = modes.getEffectiveMode();
    expect(modes.setMode(mode, true)).toBe(true);
    try {
      const result = await makeExecutor(true).execute('Read', { file_path: notePath }, { sessionId: `ask-read-${mode}` });
      expect(requests).toHaveLength(1);
      expect(result.success).toBe(true);
      expect(bodyOf(result)).toContain(MARKER);
    } finally {
      modes.setMode(previous, true);
    }
  });

  it('skill 预授权盖不住 Read 的 ask 规则', async () => {
    const result = await makeExecutor(true).execute(
      'Read',
      { file_path: notePath },
      { sessionId: 'ask-read-pre', preApprovedTools: new Set(['Read']) },
    );
    expect(requests).toHaveLength(1);
    expect(result.success).toBe(true);
  });

  it('没有 Read ask 规则时，工作区内 Read 不进审批', async () => {
    getPolicyEngine().loadUserRules({ ask: [] }, 'user-ui');
    const result = await makeExecutor(true).execute('Read', { file_path: notePath }, { sessionId: 'ask-read-none' });
    expect(requests).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(bodyOf(result)).toContain(MARKER);
  });

  it('拒绝 Read：带原因，文件内容不进结果', async () => {
    const result = await makeExecutor(false).execute('Read', { file_path: notePath }, { sessionId: 'ask-read-deny' });
    expect(requests).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/denied|declined|permission/i);
    expect(bodyOf(result)).not.toContain(MARKER);
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it('Glob：批准后再调用仍要问', async () => {
    getPolicyEngine().loadUserRules({ ask: [GLOB_RULE] }, 'user-ui');
    const executor = makeExecutor(true);
    const first = await executor.execute('Glob', { pattern: 'notes.txt', path: dir }, { sessionId: 'ask-glob' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tool).toBe('Glob');
    expect(first.success).toBe(true);
    expect(bodyOf(first)).toContain('notes.txt');

    requests.length = 0;
    const second = await executor.execute('Glob', { pattern: 'notes.txt', path: dir }, { sessionId: 'ask-glob' });
    expect(requests).toHaveLength(1);
    expect(second.success).toBe(true);
  });

  it('Write：批准后文件只被写下这一次，下一次相同调用再问', async () => {
    getPolicyEngine().loadUserRules({ ask: [WRITE_RULE] }, 'user-ui');
    const target = path.join(dir, 'out.txt');
    const executor = makeExecutor(true);
    const first = await executor.execute(
      'Write',
      { file_path: target, content: 'written-once\n' },
      { sessionId: 'ask-write' },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tool).toBe('Write');
    expect(first.success).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('written-once\n');

    requests.length = 0;
    await executor.execute(
      'Write',
      { file_path: target, content: 'written-once\n' },
      { sessionId: 'ask-write' },
    );
    expect(requests).toHaveLength(1);
  });

  it('Write 在 bypassPermissions / acceptEdits 下仍要审批', async () => {
    getPolicyEngine().loadUserRules({ ask: [WRITE_RULE] }, 'user-ui');
    const modes = getPermissionModeManager();
    const previous = modes.getEffectiveMode();
    try {
      for (const mode of ['acceptEdits', 'bypassPermissions'] as const) {
        expect(modes.setMode(mode, true)).toBe(true);
        requests.length = 0;
        const target = path.join(dir, `out-${mode}.txt`);
        const result = await makeExecutor(true).execute(
          'Write',
          { file_path: target, content: `${mode}\n` },
          { sessionId: `ask-write-${mode}` },
        );
        expect(requests).toHaveLength(1);
        expect(result.success).toBe(true);
        expect(await fs.readFile(target, 'utf8')).toBe(`${mode}\n`);
      }
    } finally {
      modes.setMode(previous, true);
    }
  });

  it('web_fetch：拒绝后不发请求', async () => {
    getPolicyEngine().loadUserRules({ ask: [WEB_FETCH_RULE] }, 'user-ui');
    const result = await makeExecutor(false).execute(
      'web_fetch',
      { url: 'https://example.com/notes', prompt: 'title' },
      { sessionId: 'ask-webfetch-deny' },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tool).toBe('web_fetch');
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/denied|declined|permission/i);
  });

  it('Bash(rm *) 不作用于 Read；一条工具的 ask 规则不作用于另一条', async () => {
    getPolicyEngine().loadUserRules({ ask: [BASH_RM_RULE] }, 'user-ui');
    const bashRuled = await makeExecutor(true).execute('Read', { file_path: notePath }, { sessionId: 'ask-cross-bash' });
    expect(requests).toHaveLength(0);
    expect(bashRuled.success).toBe(true);

    getPolicyEngine().loadUserRules({ ask: [WRITE_RULE] }, 'user-ui');
    const writeRuled = await makeExecutor(true).execute('Read', { file_path: notePath }, { sessionId: 'ask-cross-write' });
    expect(requests).toHaveLength(0);
    expect(writeRuled.success).toBe(true);

    getPolicyEngine().loadUserRules({ ask: [READ_RULE] }, 'user-ui');
    const readRuledGlob = await makeExecutor(true).execute(
      'Glob',
      { pattern: 'notes.txt', path: dir },
      { sessionId: 'ask-cross-glob' },
    );
    expect(requests).toHaveLength(0);
    expect(readRuledGlob.success).toBe(true);
  });

  it('已注册工具里，每条用户 ask 规则都强制审批（防退回只扫 Bash）', () => {
    const tools = getAllToolDefinitions();
    const eligible = tools.filter((tool) => validateUserPermissionRule(tool.name, 'ask').ok);
    expect(eligible.map((tool) => tool.name)).toEqual(expect.arrayContaining(['Read', 'Glob', 'Write', 'web_fetch', 'Bash']));
    resetPolicyEngine();
    getPolicyEngine().loadUserRules({ ask: eligible.map((tool) => tool.name) }, 'user-ui');
    const misses: string[] = [];
    for (const tool of eligible) {
      const result = evaluateGuardFabricGate({
        executionToolName: tool.name,
        policyToolName: normalizeToolName(tool.name),
        params: {},
        topology: 'main',
        sessionId: 'ask-all-tools',
        permissionLevel: tool.permissionLevel,
      });
      if (result.forceApproval !== true || result.userAskRuleOnly !== true || result.traceStep?.rule !== `user-prompt-${tool.name}`) {
        misses.push(`${tool.name}:${result.traceStep?.rule ?? result.deny?.reason ?? 'no-force'}`);
      }
    }
    expect(misses).toEqual([]);
  });
});

describe('无人值守 / 断线会话撞上用户 ask 规则会停车', () => {
  let dir: string;
  let db: InstanceType<typeof Database>;
  let repo: PendingApprovalRepository;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join('/tmp', 'ask-rule-park-'));
    loggerMock.info.mockClear();
    resetPolicyEngine();
    resetPermissionModeManager();
    getToolCache().clear();
    getPolicyEngine().loadUserRules({ ask: [READ_RULE] }, 'user-ui');
    db = new Database(':memory:');
    db.exec(`CREATE TABLE pending_approvals (
      id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
      payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT
    )`);
    repo = new PendingApprovalRepository(db);
  });

  afterEach(async () => {
    resetPolicyEngine();
    resetPermissionModeManager();
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function readWhileParked(shape: 'scheduled' | 'first-wake' | 'detached'): Promise<void> {
    const sessionId = `ask-park-${shape}`;
    const modes = getPermissionModeManager();
    if (shape !== 'detached') modes.markUnattendedSession(sessionId);
    if (shape === 'first-wake') modes.markFirstWakeSession(sessionId);
    const note = path.join(dir, `${shape}.txt`);
    await fs.writeFile(note, 'PARK_MARKER_SHOULD_NOT_LEAK');
    const seen: Array<Record<string, unknown>> = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: () => ({
        permissions: { autoApprove: { read: true, write: true, execute: true, network: true } },
      }) as unknown as AppSettings,
      isDevModeAutoApproveEnabled: () => true,
      getExecutionTopology: () => (shape === 'detached' ? 'main' : 'async_agent'),
      hasApprovalUi: () => shape === 'detached',
      isDetachedRun: () => shape === 'detached',
      injectedPendingApprovalRepo: repo,
      onEvent: (event) => {
        if (event.type !== 'permission_request' || event.data.resolved) return;
        const rows = db.prepare(
          'SELECT id, kind, status, coordinator_id, payload_json FROM pending_approvals WHERE coordinator_id = ?',
        ).all(sessionId) as Array<Record<string, unknown>>;
        seen.push(...rows);
        process.stdout.write(`parked approval row (${shape}): ${JSON.stringify(rows)}\n`);
        queueMicrotask(() => {
          island.resolveParkedApproval(event.data.id, 'deny');
        });
      },
    });
    const executor = new ToolExecutor({
      workingDirectory: dir,
      requestPermission: (request) => island.requestPermission(request),
      executionTopology: shape === 'detached' ? 'main' : 'async_agent',
    });
    executor.setAuditEnabled(false);
    const result = await executor.execute('Read', { file_path: note }, { sessionId });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'tool_approval', status: 'pending', coordinator_id: sessionId });
    expect(String(seen[0]?.payload_json)).toContain('"tool":"Read"');
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/denied|declined|permission/i);
    expect(JSON.stringify(result)).not.toContain('PARK_MARKER_SHOULD_NOT_LEAK');
  }

  it('定时任务会话停车，不静默执行也不静默拒绝', async () => {
    await readWhileParked('scheduled');
  });

  it('专家首次醒来会话停车', async () => {
    await readWhileParked('first-wake');
  });

  it('断线会话停车', async () => {
    await readWhileParked('detached');
  });

  it('前台 bypass + devMode + autoApprove.read 盖不住 Read ask 规则', async () => {
    const modes = getPermissionModeManager();
    const previous = modes.getEffectiveMode();
    expect(modes.setMode('bypassPermissions', true)).toBe(true);
    const sessionId = 'ask-foreground-bypass';
    const raised: Array<{ tool?: string; forceConfirm?: boolean }> = [];
    try {
      const island = new OrchestratorPermissionIsland({
        getSettings: () => ({
          permissions: { autoApprove: { read: true, write: true, execute: true, network: true } },
        }) as unknown as AppSettings,
        isDevModeAutoApproveEnabled: () => true,
        getExecutionTopology: () => 'main',
        hasApprovalUi: () => true,
        injectedPendingApprovalRepo: repo,
        onEvent: (event) => {
          if (event.type !== 'permission_request' || event.data.resolved) return;
          raised.push({ tool: event.data.tool, forceConfirm: event.data.forceConfirm });
          island.handlePermissionResponse(event.data.id, 'deny');
        },
      });
      const executor = new ToolExecutor({
        workingDirectory: dir,
        requestPermission: (request) => island.requestPermission(request),
      });
      executor.setAuditEnabled(false);
      const result = await executor.execute('Read', { file_path: path.join(dir, 'missing-not-created.txt') }, { sessionId });
      expect(raised).toEqual([{ tool: 'Read', forceConfirm: true }]);
      expect(result.success).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get()).toEqual({ n: 0 });
    } finally {
      modes.setMode(previous, true);
    }
  });
});
