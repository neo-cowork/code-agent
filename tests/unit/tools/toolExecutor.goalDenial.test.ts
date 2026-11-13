import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDenialRegistry } from '../../../src/host/security/denialRegistry';
import { createLogger } from '../../../src/host/services/infra/logger';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { agentErrorZh, agentErrorEn } from '../../../src/renderer/i18n/agentError';
import { HostReasonCode, type PermissionDenialSource } from '../../../src/shared/contract/permission';

vi.unmock('better-sqlite3');
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({ generateBashDescription: async () => null }));
vi.mock('../../../src/host/security/execPolicy', async (original) => ({
  ...await original<typeof import('../../../src/host/security/execPolicy')>(),
  getExecPolicyStore: () => ({ match: () => null, getRules: () => [], learnFromApproval: () => false }),
}));

const guidance = 'The user just declined this kind of action. Do not request approval for the same goal again '
  + 'by rewording it or changing the command or arguments. First ask the user one short question '
  + 'about how to proceed: use AskUserQuestion if available, otherwise your final message. '
  + 'For unattended, scheduled or background runs, put that question in your final message. '
  + 'Wait for a new user message before requesting approval for this kind of action again.';

describe('same-goal denial at the ToolExecutor ask boundary', () => {
  let cwd: string;
  let db: InstanceType<typeof Database>;
  let repo: PendingApprovalRepository;
  beforeEach(async () => {
    getDenialRegistry().clearAll();
    cwd = await mkdtemp(join(tmpdir(), 'goal-denial-'));
    db = new Database(':memory:');
    db.exec(`CREATE TABLE pending_approvals (
      id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
      payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT
    )`);
    repo = new PendingApprovalRepository(db);
  });
  afterEach(async () => { vi.restoreAllMocks(); db.close(); await rm(cwd, { recursive: true, force: true }); });

  function executor(source: PermissionDenialSource = 'user', message?: string, readOnly = false) {
    let seq = 0;
    const requestPermission = vi.fn(async () => {
      const id = `approval-${++seq}`;
      repo.insert({ id, kind: 'tool_approval', agentId: null, agentName: null,
        coordinatorId: 'goal-session', payload: { tool: 'Bash' }, submittedAt: seq });
      repo.resolve({ id, status: 'rejected', feedback: source, resolvedAt: seq });
      return { approved: false, denialSource: source, message };
    });
    const tool = new ToolExecutor({ workingDirectory: cwd, requestPermission, permissionModeOverride: readOnly ? 'readOnly' : undefined });
    tool.setAuditEnabled(false);
    return { tool, requestPermission };
  }
  const options = { sessionId: 'goal-session', sourceMessageId: 'user-1' };

  it('pins English model guidance and zh/en user summaries through execute', async () => {
    const { tool } = executor();
    const result = await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
    expect(result.error).toBe(`Permission denied by user. ${guidance}`);
    expect(result.metadata?.hostReason).toMatchObject({ code: HostReasonCode.PermissionDeniedByUser });
    expect(agentErrorZh.agentError.hostReasons[HostReasonCode.PermissionDeniedByUser].summary).toBe('你拒绝了{toolName}');
    expect(agentErrorEn.agentError.hostReasons[HostReasonCode.PermissionDeniedByUser].summary).toBe('You declined {toolName}');
  });

  it.each([
    ['foreground', options],
    ['scheduled/background without source message', { sessionId: 'goal-session', runId: 'run-nightly-1' }],
  ])('%s: changed command/arguments cause zero new pending rows', async (_label, scope) => {
    const { tool, requestPermission } = executor();
    await tool.execute('Bash', { command: 'find . -name draft -delete' }, scope);
    const before = db.prepare('SELECT * FROM pending_approvals').all();
    const warn = vi.spyOn(Object.getPrototypeOf(createLogger('DenialRegistry')) as ReturnType<typeof createLogger>, 'warn');
    const result = await tool.execute('bash', { command: 'find . -name backup -exec rm {} \\;' }, scope);
    process.stdout.write(`pending_approvals before: ${JSON.stringify(before)}\n`);
    process.stdout.write(`pending_approvals after: ${JSON.stringify(db.prepare('SELECT * FROM pending_approvals').all())}\n`);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toEqual(before);
    expect(result.error).toBe(guidance);
    expect(warn).toHaveBeenCalledWith('user-denied-goal-sticky: refusing approval before ask/park', expect.objectContaining({ toolFamily: 'Bash' }));
    process.stdout.write(`refusal log: ${JSON.stringify(warn.mock.calls.find(([name]) => name.startsWith('user-denied-goal-sticky')))}\n`);
  });

  it('new user message in the same session permits a new approval', async () => {
    const { tool, requestPermission } = executor();
    await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
    await tool.execute('Bash', { command: 'find . -name backup -delete' }, { ...options, sourceMessageId: 'user-2' });
    expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toHaveLength(2);
  });

  it('tomorrow is a new run when no source message exists', async () => {
    const { tool, requestPermission } = executor();
    await tool.execute('Bash', { command: 'find . -name draft -delete' }, { sessionId: 'goal-session', runId: 'night-1' });
    await tool.execute('Bash', { command: 'find . -name backup -delete' }, { sessionId: 'goal-session', runId: 'night-2' });
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });

  it('read-only command after rejection still executes without approval', async () => {
    const { tool, requestPermission } = executor();
    await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
    const result = await tool.execute('Bash', { command: 'pwd' }, options);
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it.each(['timeout', 'cancelled', 'fail-closed', 'scripted', 'no-approval-ui'] as const)('%s does not trigger goal sticky', async (source) => {
    const { tool, requestPermission } = executor(source);
    await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
    await tool.execute('Bash', { command: 'find . -name backup -delete' }, options);
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });

  it('readOnly mode must not replace a real user denial with mode advice', async () => {
    const { tool } = executor('user', undefined, true);
    const result = await tool.execute('Bash', { command: 'pwd' }, options);
    expect(result.error).toBe(`Permission denied by user. ${guidance}`);
  });

  it('responder messages cannot hide stop-and-ask guidance', async () => {
    const { tool } = executor('user', 'declined from inbox');
    const result = await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
    expect(result.error).toBe(`declined from inbox ${guidance}`);
  });
});
