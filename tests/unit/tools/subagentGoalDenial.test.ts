import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDenialRegistry } from '../../../src/host/security/denialRegistry';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { createProtocolSubagentExecutionContext } from '../../../src/host/agent/subagentExecutionContext';
import type { AppSettings } from '../../../src/shared/contract';

vi.unmock('better-sqlite3');
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({ generateBashDescription: async () => null }));
vi.mock('../../../src/host/security/execPolicy', async (original) => ({
  ...await original<typeof import('../../../src/host/security/execPolicy')>(),
  getExecPolicyStore: () => ({ match: () => null, getRules: () => [], learnFromApproval: () => false }),
}));

const stickyText = 'The user just declined this kind of action.';

describe('same-goal denial propagates to sub-agents (createSubagentToolRuntime lane)', () => {
  let cwd: string;
  let db: InstanceType<typeof Database>;
  let humanPrompts: number;
  let island: OrchestratorPermissionIsland;
  let parent: ToolExecutor;

  beforeEach(async () => {
    getDenialRegistry().clearAll();
    resetPermissionModeManager();
    cwd = await mkdtemp(join(tmpdir(), 'subagent-goal-denial-'));
    db = new Database(':memory:');
    db.exec(`CREATE TABLE pending_approvals (
      id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
      payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT
    )`);
    humanPrompts = 0;
    for (const sid of ['goal-session', 'other-session']) getPermissionModeManager().markUnattendedSession(sid);
    island = new OrchestratorPermissionIsland({
      getSettings: () => ({
        permissions: { autoApprove: { read: false, write: false, execute: false, network: false } },
      }) as unknown as AppSettings,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      injectedPendingApprovalRepo: new PendingApprovalRepository(db),
      onEvent: (event) => {
        if (event.type === 'permission_request' && !event.data.resolved) {
          humanPrompts += 1;
          queueMicrotask(() => island.resolveParkedApproval(event.data.id, 'deny'));
        }
      },
    });
    parent = new ToolExecutor({
      workingDirectory: cwd,
      requestPermission: (req) => island.requestPermission(req),
    });
    parent.setAuditEnabled(false);
  });
  afterEach(async () => {
    resetPermissionModeManager();
    vi.restoreAllMocks();
    db.close();
    await rm(cwd, { recursive: true, force: true });
  });

  /** Child lane built by the production factory; sourceMessageId/sessionId come from the spawn context. */
  function child(sessionId: string, sourceMessageId: string | undefined) {
    const context = {
      runId: 'child-run-1',
      sourceMessageId,
      sessionId,
      cwd,
      permission: { request: (req: Parameters<OrchestratorPermissionIsland['requestPermission']>[0]) => island.requestPermission(req) },
    } as unknown as SubagentExecutionContext;
    const { executor } = createSubagentToolRuntime({
      context,
      sessionId,
      effectiveMode: 'default',
      identity: { agentId: 'child-1', runId: 'child-run-1' },
      allowedToolNames: new Set(['Bash']),
      checkToolExecution: () => true,
    });
    executor.setAuditEnabled(false);
    const run = (command: string) => executor.execute('Bash', { command }, {
      runId: 'child-run-1', sessionId, sourceMessageId, agentId: 'child-1', spawnDepth: 1,
    });
    return { run };
  }
  const mainOptions = { sessionId: 'goal-session', sourceMessageId: 'user-1' };

  it('(a) child of the same message is refused with the sticky text and zero human prompts', async () => {
    await parent.execute('Bash', { command: 'find . -name draft -delete' }, mainOptions);
    expect(humanPrompts).toBe(1);
    const rows = db.prepare('SELECT * FROM pending_approvals').all();
    const result = await child('goal-session', 'user-1').run('find . -name backup -exec rm {} +');
    expect(result.error).toContain(stickyText);
    expect(humanPrompts).toBe(1);
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toEqual(rows);
  });

  it('(b) child read-only command still runs', async () => {
    await parent.execute('Bash', { command: 'find . -name draft -delete' }, mainOptions);
    const result = await child('goal-session', 'user-1').run('pwd');
    expect(result.success).toBe(true);
    expect(humanPrompts).toBe(1);
  });

  it('(c) a new user message lets the child ask for approval again', async () => {
    await parent.execute('Bash', { command: 'find . -name draft -delete' }, mainOptions);
    await child('goal-session', 'user-2').run('find . -name backup -delete');
    expect(humanPrompts).toBe(2);
  });

  it('(d) a different session is not affected', async () => {
    await parent.execute('Bash', { command: 'find . -name draft -delete' }, mainOptions);
    await child('other-session', 'user-1').run('find . -name backup -delete');
    expect(humanPrompts).toBe(2);
  });

  it('(e) spawn context built from the parent tool context carries sourceMessageId into the child lane', async () => {
    await parent.execute('Bash', { command: 'find . -name draft -delete' }, mainOptions);
    const spawned = createProtocolSubagentExecutionContext(
      { sessionId: 'goal-session', sourceMessageId: 'user-1', runId: 'parent-run', workingDir: cwd } as never,
      (async () => ({ allow: true })) as never,
      { modelConfig: {} as never, resolver: {} as never },
    );
    expect(spawned.sourceMessageId).toBe('user-1');
    const { executor } = createSubagentToolRuntime({
      context: { ...spawned, permission: { request: (req: never) => island.requestPermission(req) } } as unknown as SubagentExecutionContext,
      sessionId: 'goal-session',
      effectiveMode: 'default',
      identity: { agentId: 'child-2', runId: 'child-run-2' },
      allowedToolNames: new Set(['Bash']),
      checkToolExecution: () => true,
    });
    executor.setAuditEnabled(false);
    const result = await executor.execute('Bash', { command: 'find . -name x -delete' }, {
      runId: 'child-run-2', sessionId: 'goal-session', sourceMessageId: spawned.sourceMessageId, agentId: 'child-2', spawnDepth: 1,
    });
    expect(result.error).toContain(stickyText);
    expect(humanPrompts).toBe(1);
  });

  it('(f) a child with no parent user message (cron/recovery) keeps run scope and may ask', async () => {
    await parent.execute('Bash', { command: 'find . -name draft -delete' }, mainOptions);
    await child('goal-session', undefined).run('find . -name backup -delete');
    expect(humanPrompts).toBe(2);
  });
});
