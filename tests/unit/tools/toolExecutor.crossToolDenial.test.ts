import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDenialRegistry } from '../../../src/host/security/denialRegistry';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { bindToolGrantDatabase, clearToolRunGrants } from '../../../src/host/permissions/toolGrantStore';
import { createLogger } from '../../../src/host/services/infra/logger';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { getToolLedgerSink, setToolLedgerSink, type ToolLedgerSink } from '../../../src/host/tools/toolLedgerSink';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { PermissionDecisionRepository } from '../../../src/host/services/core/repositories/PermissionDecisionRepository';
import type { AgentEvent, AppSettings } from '../../../src/shared/contract';
import type { PermissionDenialSource } from '../../../src/shared/contract/permission';

vi.unmock('better-sqlite3');
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({ generateBashDescription: async () => null }));
vi.mock('../../../src/host/security/execPolicy', async (original) => ({
  ...await original<typeof import('../../../src/host/security/execPolicy')>(),
  getExecPolicyStore: () => ({ match: () => null, getRules: () => [], learnFromApproval: () => false }),
}));

describe('cross-tool / analysis-failed goal denial at the ToolExecutor ask boundary', () => {
  let cwd: string;
  let db: InstanceType<typeof Database>;
  let repo: PendingApprovalRepository;
  let decisionRepo: PermissionDecisionRepository;
  let previousLedgerSink: ToolLedgerSink;
  beforeEach(async () => {
    getDenialRegistry().clearAll();
    resetPermissionModeManager();
    cwd = await mkdtemp(join(tmpdir(), 'goal-denial-'));
    db = new Database(':memory:');
    db.exec(`CREATE TABLE pending_approvals (
      id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
      payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT
    );
    CREATE TABLE permission_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      summary TEXT,
      final_outcome TEXT NOT NULL,
      history_outcome TEXT NOT NULL,
      reason TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      wait_ms INTEGER,
      origin TEXT,
      recorded_at INTEGER NOT NULL,
      trace_json TEXT,
      policy_hash TEXT
    );
    CREATE TABLE tool_permission_grants (
      tool_key TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      target TEXT,
      granted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    repo = new PendingApprovalRepository(db);
    decisionRepo = new PermissionDecisionRepository(db);
    bindToolGrantDatabase(db, true);
    previousLedgerSink = getToolLedgerSink();
    setToolLedgerSink({
      appendPermissionDecision: (input) => decisionRepo.append(input),
      appendToolExecutionBegin: () => {},
      appendToolExecutionComplete: () => {},
    });
  });
  afterEach(async () => {
    clearToolRunGrants('goal-session');
    bindToolGrantDatabase(null, true);
    setToolLedgerSink(previousLedgerSink);
    resetPermissionModeManager();
    vi.restoreAllMocks();
    db.close();
    await rm(cwd, { recursive: true, force: true });
  });

  function executor(
    source: PermissionDenialSource = 'user',
    message?: string,
    readOnly = false,
    opts: { unattended?: boolean; devMode?: () => boolean } = {},
  ) {
    if (opts.unattended ?? true) {
      getPermissionModeManager().markUnattendedSession('goal-session');
    }
    let humanPrompts = 0;
    const events: AgentEvent[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: () => ({
        permissions: { autoApprove: { read: false, write: false, execute: false, network: false } },
      }) as unknown as AppSettings,
      isDevModeAutoApproveEnabled: opts.devMode ?? (() => false),
      getExecutionTopology: () => ((opts.unattended ?? true) ? 'async_agent' : 'main'),
      hasApprovalUi: () => !(opts.unattended ?? true),
      injectedPendingApprovalRepo: repo,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'permission_request' && !event.data.resolved) {
          humanPrompts += 1;
          const machineDenial = source === 'user' ? undefined : source;
          queueMicrotask(() => {
            if (opts.unattended ?? true) {
              island.resolveParkedApproval(event.data.id, 'deny', message, machineDenial);
            } else {
              island.handlePermissionResponse(event.data.id, 'deny');
            }
          });
        }
      },
    });
    const requestPermission = vi.fn((req: Parameters<OrchestratorPermissionIsland['requestPermission']>[0]) => (
      island.requestPermission(req)
    ));
    const tool = new ToolExecutor({
      workingDirectory: cwd,
      requestPermission,
      permissionModeOverride: readOnly ? 'readOnly' : undefined,
    });
    tool.setAuditEnabled(false);
    return { tool, requestPermission, events, getHumanPrompts: () => humanPrompts };
  }
  const options = { sessionId: 'goal-session', sourceMessageId: 'user-1' };
  const rows = () => db.prepare('SELECT reason, wait_ms FROM permission_decisions ORDER BY id').all() as Array<{ reason: string; wait_ms: number | null }>;
  const stickyLogs = () => warn.mock.calls.filter(([name]: unknown[]) => String(name).startsWith('user-denied-goal-sticky'));
  let warn: ReturnType<typeof vi.spyOn>;
  let outside: string;
  beforeEach(() => {
    warn = vi.spyOn(Object.getPrototypeOf(createLogger('DenialRegistry')) as ReturnType<typeof createLogger>, 'warn');
    // Not under tmpdir (the classifier auto-approves temp writes) and never created: every call here is denied.
    outside = join(homedir(), 'Downloads', 'goal-denial-never-created');
  });

  it.each([
    ['redirect', (f: string) => `echo plan > ${f}`],
    ['rm', (f: string) => `rm ${f}`],
    ['sed -i', (f: string) => `sed -i s/a/b/ ${f}`],
  ])('Write denied then file-changing Bash (%s) is refused with 0 extra prompts / pending rows', async (_n, cmd) => {
    const { tool, getHumanPrompts } = executor();
    const target = join(outside, 'plan.md');
    const first = await tool.execute('Write', { file_path: target, content: 'plan' }, options);
    expect(first.success).toBe(false);
    expect(getHumanPrompts()).toBe(1);
    const pending = db.prepare('SELECT * FROM pending_approvals').all();
    expect(pending).toHaveLength(1);
    const retry = await tool.execute('Bash', { command: cmd(target) }, options);
    expect(retry.success).toBe(false);
    expect(getHumanPrompts()).toBe(1);
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toEqual(pending);
    expect(rows().map((r) => r.reason)).toContain('goal-sticky-host');
    expect(stickyLogs()[0]?.[1]).toMatchObject({ reason: 'cross-tool' });
  });

  it('Bash file-changing denial also blocks a later Write in the same message', async () => {
    const { tool, getHumanPrompts } = executor();
    await tool.execute('Bash', { command: `rm ${join(outside, 'a.md')}` }, options);
    const retry = await tool.execute('Write', { file_path: join(outside, 'b.md'), content: 'x' }, options);
    expect(retry.success).toBe(false);
    expect(getHumanPrompts()).toBe(1);
  });

  it('read-only Bash after a Write denial keeps its normal path; a new message asks again', async () => {
    const { tool, getHumanPrompts } = executor();
    const target = join(outside, 'plan.md');
    await tool.execute('Write', { file_path: target, content: 'plan' }, options);
    const readOnly = await tool.execute('Bash', { command: 'pwd' }, options);
    expect(readOnly.success).toBe(true);
    expect(getHumanPrompts()).toBe(1);
    expect(stickyLogs()).toHaveLength(0);
    await tool.execute('Bash', { command: `echo plan > ${target}` }, { ...options, sourceMessageId: 'user-2' });
    expect(getHumanPrompts()).toBe(2);
  });

  it('analysis-failed command after a denial is refused before any card, with a distinct reason', async () => {
    const { tool, getHumanPrompts } = executor();
    await tool.execute('Bash', { command: 'rm -rf old-installers' }, options);
    const pending = db.prepare('SELECT * FROM pending_approvals').all();
    const retry = await tool.execute('Bash', { command: 'echo "PWD=$(pwd)"; ls -d ~/Downloads' }, options);
    expect(retry.success).toBe(false);
    expect(getHumanPrompts()).toBe(1);
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toEqual(pending);
    expect(stickyLogs()[0]?.[1]).toMatchObject({ reason: 'analysis-failed' });
    expect(rows().at(-1)?.reason).toContain('goal-sticky-host');
  });

  it('analysis-failed command after a Write denial is refused too (effect class, not tool name)', async () => {
    const { tool, getHumanPrompts } = executor();
    await tool.execute('Write', { file_path: join(outside, 'plan.md'), content: 'plan' }, options);
    const retry = await tool.execute('Bash', { command: 'echo "PWD=$(pwd)" > ~/Downloads/x.md' }, options);
    expect(retry.success).toBe(false);
    expect(getHumanPrompts()).toBe(1);
    expect(stickyLogs()[0]?.[1]).toMatchObject({ reason: 'analysis-failed' });
  });

  it('analysis-failed command without a prior denial still shows its card and is never recorded as a user denial', async () => {
    const { tool, getHumanPrompts } = executor();
    const first = await tool.execute('Bash', { command: 'echo "PWD=$(pwd)"; ls -d ~/Downloads' }, options);
    expect(first.success).toBe(false);
    expect(getHumanPrompts()).toBe(1);
    expect(stickyLogs()).toHaveLength(0);
    await tool.execute('Bash', { command: 'mkdir -p sorted' }, options);
    expect(getHumanPrompts()).toBe(2);
    expect(stickyLogs()).toHaveLength(0);
  });

  it('parked/background path (OrchestratorPermissionIsland) refuses cross-tool without parking', async () => {
    const { tool, getHumanPrompts } = executor('user', undefined, false, { unattended: true });
    const scope = { sessionId: 'goal-session', runId: 'run-nightly-9' };
    const target = join(outside, 'plan.md');
    await tool.execute('Write', { file_path: target, content: 'plan' }, scope);
    await tool.execute('Bash', { command: `echo plan > ${target}` }, scope);
    expect(getHumanPrompts()).toBe(1);
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toHaveLength(1);
  });
});
