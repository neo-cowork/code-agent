import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeActionFingerprint, getDenialRegistry } from '../../../src/host/security/denialRegistry';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import {
  bindToolGrantDatabase,
  clearToolRunGrants,
  mintTool24hGrant,
  mintToolRunGrant,
} from '../../../src/host/permissions/toolGrantStore';
import { getSessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';
import { createLogger } from '../../../src/host/services/infra/logger';
import { getToolResolver } from '../../../src/host/tools/dispatch/toolResolver';
import { userDeniedGoalStickyError } from '../../../src/host/tools/toolPermissionClassification';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { getToolLedgerSink, setToolLedgerSink, type ToolLedgerSink } from '../../../src/host/tools/toolLedgerSink';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { PermissionDecisionRepository } from '../../../src/host/services/core/repositories/PermissionDecisionRepository';
import { agentErrorZh, agentErrorEn } from '../../../src/renderer/i18n/agentError';
import type { AgentEvent, AppSettings } from '../../../src/shared/contract';
import { HostReasonCode, type PermissionDenialSource } from '../../../src/shared/contract/permission';

vi.unmock('better-sqlite3');
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({ generateBashDescription: async () => null }));
vi.mock('../../../src/host/security/execPolicy', async (original) => ({
  ...await original<typeof import('../../../src/host/security/execPolicy')>(),
  getExecPolicyStore: () => ({ match: () => null, getRules: () => [], learnFromApproval: () => false }),
}));

const guidance = userDeniedGoalStickyError('Bash').modelText;

describe('same-goal denial at the ToolExecutor ask boundary', () => {
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
    opts: { unattended?: boolean; devMode?: () => boolean; allowAfterDenial?: boolean } = {},
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
          const response = opts.allowAfterDenial && humanPrompts > 1 ? 'allow' : 'deny';
          const machineDenial = source === 'user' ? undefined : source;
          queueMicrotask(() => {
            if (opts.unattended ?? true) {
              island.resolveParkedApproval(event.data.id, response, message, machineDenial);
            } else {
              island.handlePermissionResponse(event.data.id, response);
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

  it('pins English model guidance and zh/en user summaries through execute', async () => {
    const { tool } = executor();
    const result = await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
    expect(result.error).toBe(`Permission denied by user. ${guidance}`);
    expect(result.metadata?.hostReason).toMatchObject({ code: HostReasonCode.PermissionDeniedByUser });
    expect(agentErrorZh.agentError.hostReasons[HostReasonCode.PermissionDeniedByUser].summary).toBe('你拒绝了{toolName}');
    expect(agentErrorEn.agentError.hostReasons[HostReasonCode.PermissionDeniedByUser].summary).toBe('You declined {toolName}');
  });

  it.each([
    ['foreground', options, false],
    ['scheduled/background without source message', { sessionId: 'goal-session', runId: 'run-nightly-1' }, true],
  ])('%s: changed command/arguments cause zero new pending rows', async (_label, scope, unattended) => {
    const { tool, getHumanPrompts } = executor('user', undefined, false, { unattended });
    await tool.execute('Bash', { command: 'find . -name draft -delete' }, scope);
    const before = db.prepare('SELECT * FROM pending_approvals').all();
    expect(before).toHaveLength(unattended ? 1 : 0);
    const warn = vi.spyOn(Object.getPrototypeOf(createLogger('DenialRegistry')) as ReturnType<typeof createLogger>, 'warn');
    const result = await tool.execute('bash', { command: 'find . -name backup -exec rm {} \\;' }, scope);
    process.stdout.write(`pending_approvals before: ${JSON.stringify(before)}\n`);
    process.stdout.write(`pending_approvals after: ${JSON.stringify(db.prepare('SELECT * FROM pending_approvals').all())}\n`);
    expect(getHumanPrompts()).toBe(1);
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toEqual(before);
    expect(result.error).toBe(guidance);
    expect(warn).toHaveBeenCalledWith('user-denied-goal-sticky: refusing approval before ask/park', expect.objectContaining({ toolFamily: 'Bash' }));
    process.stdout.write(`refusal log: ${JSON.stringify(warn.mock.calls.find(([name]) => name.startsWith('user-denied-goal-sticky')))}\n`);
  });

  it('new user message in the same session permits a new approval', async () => {
    const { tool, getHumanPrompts } = executor();
    await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
    await tool.execute('Bash', { command: 'find . -name backup -delete' }, { ...options, sourceMessageId: 'user-2' });
    expect(getHumanPrompts()).toBe(2);
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toHaveLength(2);
  });

  it('denied write ends the turn without questions and a new user message asks then executes', async () => {
    const { tool, getHumanPrompts } = executor('user', undefined, true, { allowAfterDenial: true });
    const file = join(cwd, 'notes-summary.md');
    const args = { file_path: file, content: '- Discussed plans\n- Assigned owners\n- Set next meeting\n' };
    const denied = await tool.execute('Write', args, options);
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('End this turn now with exactly one short final sentence: state that the declined action was not performed and, if anything was completed earlier in this turn, mention it in the same sentence.');
    expect(denied.error).toContain('Do not add a second sentence, a list, or an offer to continue.');
    expect(denied.error).toContain('Do not claim that nothing was changed.');
    expect(denied.error).toContain('Do not ask a question or call a question tool.');
    expect(denied.error).toContain('state in one final sentence that the action was declined and skipped.');
    expect(denied.error).toContain('Wait for a new user message before requesting approval');
    expect(denied.error).not.toMatch(/how to proceed|AskUserQuestion/);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const retry = await tool.execute('Write', args, options);
    expect(retry.success).toBe(false);
    expect(getHumanPrompts()).toBe(1);

    const allowed = await tool.execute('Write', args, { ...options, sourceMessageId: 'user-2' });
    expect(allowed.success).toBe(true);
    expect(getHumanPrompts()).toBe(2);
    expect(db.prepare('SELECT status FROM pending_approvals ORDER BY submitted_at').all())
      .toEqual([{ status: 'rejected' }, { status: 'approved' }]);
    expect(await readFile(file, 'utf8')).toBe(args.content);
  });

  it('tomorrow is a new run when no source message exists', async () => {
    const { tool, getHumanPrompts } = executor();
    await tool.execute('Bash', { command: 'find . -name draft -delete' }, { sessionId: 'goal-session', runId: 'night-1' });
    await tool.execute('Bash', { command: 'find . -name backup -delete' }, { sessionId: 'goal-session', runId: 'night-2' });
    expect(getHumanPrompts()).toBe(2);
  });

  it('read-only command after rejection still executes without approval', async () => {
    const { tool, getHumanPrompts } = executor();
    await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
    const result = await tool.execute('Bash', { command: 'pwd' }, options);
    expect(result.success).toBe(true);
    expect(getHumanPrompts()).toBe(1);
  });

  it('auto-approve inside the permission handler still approves after a family denial', async () => {
    let devMode = false;
    const { tool, getHumanPrompts } = executor('user', undefined, false, { unattended: false, devMode: () => devMode });
    const denied = await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
    expect(denied.success).toBe(false);
    devMode = true;
    const allowed = await tool.execute('Bash', { command: 'mkdir -p sorted' }, options);
    expect(allowed.success).toBe(true);
    expect(getHumanPrompts()).toBe(1);
  });

  it.each(['timeout', 'cancelled', 'fail-closed', 'scripted', 'no-approval-ui', 'goal-sticky-host'] as const)('%s does not trigger goal sticky', async (source) => {
    const { tool, getHumanPrompts } = executor(source);
    await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
    await tool.execute('Bash', { command: 'find . -name backup -delete' }, options);
    expect(getHumanPrompts()).toBe(2);
  });

  it('readOnly mode must not replace a real user denial with mode advice', async () => {
    const { tool } = executor('user', undefined, true);
    const result = await tool.execute('Bash', { command: 'pwd' }, options);
    expect(result.error).toBe(`Permission denied by user. ${guidance}`);
  });

  it('responder messages cannot hide end-the-turn guidance', async () => {
    const { tool } = executor('user', 'declined from inbox');
    const result = await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
    expect(result.error).toBe(`declined from inbox ${guidance}`);
  });

  it('interactive denial emits zero permission_request events on retry so renderer memory never sees a card', async () => {
    const { tool, events } = executor('user', undefined, false, { unattended: false });
    await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
    const retry = await tool.execute('Bash', { command: 'mkdir -p sorted' }, options);
    expect(retry.success).toBe(false);
    expect(retry.error).toBe(guidance);
    expect(events.filter((e) => e.type === 'permission_request')).toHaveLength(1);
  });

  it.each(['run', '24h'] as const)(
    'prior %s tool grant yields to same-message family denial and resumes on a new sourceMessageId',
    async (tier) => {
      if (tier === 'run') {
        mintToolRunGrant('goal-session', 'Bash');
      } else {
        mintTool24hGrant('Bash');
      }
      const { tool, events, getHumanPrompts } = executor('user', undefined, false, { unattended: true });
      const triggerPermissionDenied = vi.fn(async () => {});
      const hookManager = { triggerPermissionDenied } as unknown as NonNullable<
        Parameters<ToolExecutor['execute']>[2]
      >['hookManager'];

      const first = await tool.execute('Bash', { command: 'rm -rf old-installers' }, { ...options, hookManager });
      expect(first.success).toBe(false);
      expect(getHumanPrompts()).toBe(1);
      const pendingAfterFirst = db.prepare('SELECT * FROM pending_approvals').all();
      expect(pendingAfterFirst).toHaveLength(1);

      const retry = await tool.execute('Bash', { command: 'mkdir -p sorted' }, { ...options, hookManager });
      expect(retry.success).toBe(false);
      expect(retry.error).toBe(guidance);
      expect(getHumanPrompts()).toBe(1);
      expect(events.filter((e) => e.type === 'permission_request' && !e.data.resolved)).toHaveLength(1);
      expect(db.prepare('SELECT * FROM pending_approvals').all()).toEqual(pendingAfterFirst);
      expect(triggerPermissionDenied).toHaveBeenNthCalledWith(1, 'Bash', expect.any(String), 'user', 'goal-session');
      expect(triggerPermissionDenied).toHaveBeenNthCalledWith(2, 'Bash', guidance, 'runtime', 'goal-session');

      const nextTurn = await tool.execute('Bash', { command: 'mkdir -p sorted' }, {
        ...options,
        sourceMessageId: 'user-2',
        hookManager,
      });
      expect(nextTurn.success).toBe(true);
      expect(getHumanPrompts()).toBe(1);

      const decisions = decisionRepo.getBySession('goal-session');
      expect(decisions.map((d) => ({ outcome: d.historyOutcome, reason: d.reason }))).toEqual([
        { outcome: 'ask-denied', reason: 'user' },
        { outcome: 'ask-denied', reason: 'goal-sticky-host' },
        { outcome: 'auto-approve', reason: `tool_grant:${tier}` },
      ]);
    },
  );

  it('prior external standing grant yields to same-message messaging denial and resumes on a new sourceMessageId', async () => {
    const mcpTool = 'mcp__lark__im_v1_message_create';
    const resolver = getToolResolver();
    const origGetDef = resolver.getDefinition.bind(resolver);
    const origExec = resolver.execute.bind(resolver);
    vi.spyOn(resolver, 'getDefinition').mockImplementation((name) => (
      name === mcpTool
        ? {
            name: mcpTool,
            description: 'send lark message',
            inputSchema: { type: 'object', properties: {} },
            outputSchema: { type: 'object', properties: {} },
            requiresPermission: true,
            permissionLevel: 'network',
          }
        : origGetDef(name)
    ));
    vi.spyOn(resolver, 'execute').mockImplementation(async (name, args, ctx) => (
      name === mcpTool ? { success: true, output: 'sent' } : origExec(name, args, ctx)
    ));
    vi.spyOn(getSessionAutomationService(), 'matchStandingGrant').mockImplementation(
      (sid, toolName, target) => sid === 'goal-session' && toolName === mcpTool && target === 'open_id:ou_alice',
    );
    const { tool, events, getHumanPrompts } = executor('user', undefined, false, { unattended: true });

    const denied = await tool.execute(
      mcpTool,
      { params: { receive_id_type: 'open_id' }, data: { receive_id: 'ou_bob', content: 'hi' } },
      options,
    );
    expect(denied.success).toBe(false);
    const pendingAfterDenied = db.prepare('SELECT * FROM pending_approvals').all();
    expect(pendingAfterDenied).toHaveLength(1);

    const sameTurnGrantedTarget = await tool.execute(
      mcpTool,
      { params: { receive_id_type: 'open_id' }, data: { receive_id: 'ou_alice', content: 'hi' } },
      options,
    );
    expect(sameTurnGrantedTarget.success).toBe(false);
    expect(sameTurnGrantedTarget.error).toBe(guidance);
    expect(getHumanPrompts()).toBe(1);
    expect(events.filter((e) => e.type === 'permission_request' && !e.data.resolved)).toHaveLength(1);
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toEqual(pendingAfterDenied);

    const nextTurn = await tool.execute(
      mcpTool,
      { params: { receive_id_type: 'open_id' }, data: { receive_id: 'ou_alice', content: 'hi' } },
      { ...options, sourceMessageId: 'user-2' },
    );
    expect(nextTurn.success).toBe(true);
    expect(getHumanPrompts()).toBe(1);
    const decisions = decisionRepo.getBySession('goal-session');
    expect(decisions.map((d) => ({ outcome: d.historyOutcome, reason: d.reason }))).toEqual([
      { outcome: 'ask-denied', reason: 'user' },
      { outcome: 'ask-denied', reason: 'goal-sticky-host' },
      { outcome: 'auto-approve', reason: 'standing_grant:open_id:ou_alice' },
    ]);
  });

  it('guard refusal records goal-sticky-host without downgrading the real-user fingerprint entry', async () => {
    const scope = { sessionId: 'goal-session', runId: 'run-ledger-1' };
    const { tool } = executor('user', undefined, false, { unattended: true });
    const cmd = 'find . -name draft -delete';
    const fp = computeActionFingerprint('Bash', { command: cmd }, cwd);
    expect(fp).toBe('bash:find . -name draft -delete');

    await tool.execute('Bash', { command: cmd }, scope);
    expect(getDenialRegistry().find('goal-session', fp!)).toMatchObject({
      byUser: true,
      reason: 'user',
    });

    const retry = await tool.execute('Bash', { command: cmd }, scope);
    expect(retry.success).toBe(false);
    expect(retry.error).toBe(guidance);

    expect(getDenialRegistry().find('goal-session', fp!)).toMatchObject({
      byUser: true,
      reason: 'user',
    });
    expect(
      getDenialRegistry().refuseIfGoalDenied({ sessionId: 'goal-session', runId: 'run-ledger-1', tool: 'Bash' }),
    ).toMatchObject({ approved: false, denialSource: 'goal-sticky-host' });

    const decisions = decisionRepo.getBySession('goal-session');
    expect(decisions.map((d) => ({ finalOutcome: d.finalOutcome, historyOutcome: d.historyOutcome, reason: d.reason }))).toEqual([
      { finalOutcome: 'deny', historyOutcome: 'ask-denied', reason: 'user' },
      { finalOutcome: 'deny', historyOutcome: 'ask-denied', reason: 'goal-sticky-host' },
    ]);
  });
  // Tool double: the real sandbox cannot be made to fail on every CI machine, so the Bash handler is
  // replaced for the magic command below and calls the executor-built context.requestPermission
  // exactly like bash.ts' sandbox_escalate_once branch does (tool 'bash', forceConfirm, no sessionId).
  describe('in-tool sandbox-widening ask joins the goal-sticky table', () => {
    const ESCALATE = 'pwd # sandbox-escalate';
    let handlerCalls: number;
    let escalationResults: boolean[];
    beforeEach(() => {
      handlerCalls = 0;
      escalationResults = [];
      const resolver = getToolResolver();
      const origExec = resolver.execute.bind(resolver);
      vi.spyOn(resolver, 'execute').mockImplementation(async (name, args, ctx) => {
        if (name === 'Bash' && (args as { command?: string }).command === ESCALATE) {
          handlerCalls += 1;
          const allowed = await ctx.requestPermission({
            type: 'command',
            tool: 'bash',
            details: { command: ESCALATE, action: 'sandbox_escalate_once' },
            reason: 'sandbox blocked this write',
            forceConfirm: true,
          } as never);
          escalationResults.push(allowed);
          return allowed ? { success: true, output: 'ok' } : { success: false, error: 'sandbox denied' };
        }
        return origExec(name, args, ctx);
      });
    });
    const ledgerReasons = () => decisionRepo.getBySession('goal-session').map((d) => d.reason);

    it('denied in-tool card refuses the next same-message in-tool ask before a card', async () => {
      const { tool, getHumanPrompts } = executor('user', undefined, false, { unattended: false });
      await tool.execute('Bash', { command: ESCALATE }, options);
      expect(escalationResults).toEqual([false]);
      expect(handlerCalls).toBe(1);
      const promptsAfterFirst = getHumanPrompts();
      expect(promptsAfterFirst).toBeGreaterThanOrEqual(1);
      expect(getDenialRegistry().refuseIfGoalDenied(
        { sessionId: 'goal-session', sourceMessageId: 'user-1', tool: 'Bash' }, { log: false },
      )).toMatchObject({ approved: false, denialSource: 'goal-sticky-host' });

      // reworded top-level ask in the same message: refused before any card, handler not invoked again
      const retry = await tool.execute('Bash', { command: 'find . -name backup -delete' }, options);
      expect(retry.success).toBe(false);
      expect(retry.error).toBe(guidance);
      // second in-tool ask in the same message: the (read-only) top-level call runs, the in-tool ask is refused, no card
      await tool.execute('Bash', { command: ESCALATE }, options);
      expect(handlerCalls).toBe(2);
      expect(escalationResults).toEqual([false, false]);
      expect(getHumanPrompts()).toBe(promptsAfterFirst);
      expect(ledgerReasons().filter((r) => r === 'user')).toHaveLength(1);
      expect(ledgerReasons()).toContain('goal-sticky-host');
    });

    it('a new sourceMessageId asks again', async () => {
      const { tool, getHumanPrompts } = executor('user', undefined, false, { unattended: false });
      await tool.execute('Bash', { command: ESCALATE }, options);
      const before = getHumanPrompts();
      await tool.execute('Bash', { command: ESCALATE }, { ...options, sourceMessageId: 'user-2' });
      expect(getHumanPrompts()).toBeGreaterThan(before);
    });

    it('read-only command still passes after an in-tool denial', async () => {
      const { tool } = executor('user', undefined, false, { unattended: false });
      await tool.execute('Bash', { command: ESCALATE }, options);
      const result = await tool.execute('Bash', { command: 'pwd' }, options);
      expect(result.success).toBe(true);
    });

    it('top-level denial first, then in-tool ask is refused without a card', async () => {
      const { tool, getHumanPrompts } = executor('user', undefined, false, { unattended: false });
      await tool.execute('Bash', { command: 'find . -name draft -delete' }, options);
      const before = getHumanPrompts();
      const r = await tool.execute('Bash', { command: ESCALATE }, options);
      expect(r.success).toBe(false);
      expect(escalationResults).toEqual([false]);
      expect(getHumanPrompts()).toBe(before);
    });

    it('approving the in-tool card registers nothing', async () => {
      const approving = new ToolExecutor({ workingDirectory: cwd, requestPermission: async () => ({ approved: true }) });
      approving.setAuditEnabled(false);
      await approving.execute('Bash', { command: ESCALATE }, options);
      expect(escalationResults).toEqual([true]);
      expect(getDenialRegistry().refuseIfGoalDenied(
        { sessionId: 'goal-session', sourceMessageId: 'user-1', tool: 'Bash' }, { log: false },
      )).toBeNull();
    });
  });
});
