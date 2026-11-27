import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { hydrateApprovalGatesAtBoot } from '../../../src/host/agent/parkedApprovalHydration';
import { resumeSurvivingParkedApproval, type ParkedApprovalResumePorts } from '../../../src/host/agent/parkedApprovalResume';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { DEFAULT_SETTINGS } from '../../../src/host/services/core/configDefaults';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { createLogger } from '../../../src/host/services/infra/logger';
import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { Message, PermissionRequest } from '../../../src/shared/contract';

import { buildRuleString } from '../../../src/shared/permissionRuleTranslate';

vi.unmock('better-sqlite3');
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));
vi.mock('../../../src/host/agent/planApproval', () => ({
  getPlanApprovalGate: () => ({ attachPersistence: () => 0 }),
}));
vi.mock('../../../src/host/agent/swarmLaunchApproval', () => ({
  getSwarmLaunchApprovalGate: () => ({ attachPersistence: () => 0 }),
}));

const sessionId = 'attended-approval-session';
const toolCallId = 'attended-approval-tool-call';
const command = 'rm draft-2.txt';

describe('attended approval ledger mirror (real SQLite)', () => {
  let dir: string;
  let db: Database.Database;
  let sessions: SessionRepository;
  let approvals: PendingApprovalRepository;
  let runs: DurableRunRepository;
  let detached: boolean;
  let hasUi: boolean;

  function openDatabase() {
    db = new Database(path.join(dir, 'test.db'));
    db.pragma('foreign_keys = ON');
    sessions = new SessionRepository(db);
    approvals = new PendingApprovalRepository(db);
    runs = new DurableRunRepository(db);
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'attended-approval-')));
    writeFileSync(path.join(dir, 'draft-2.txt'), 'draft');
    openDatabase();
    const logger = createLogger('AttendedApprovalLedgerTest');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    runs.migrate();
    sessions.createSession({
      id: sessionId, title: 'Delete a draft', modelConfig: { provider: 'openai', model: 'gpt-5' },
      workingDirectory: dir, createdAt: Date.now(), updatedAt: Date.now(),
    });
    sessions.addMessage(sessionId, {
      id: 'assistant-tool-call', role: 'assistant', content: '', timestamp: Date.now(),
      toolCalls: [{ id: toolCallId, name: 'Bash', arguments: { command } }],
    });
    detached = false;
    hasUi = true;
    getProtocolRegistry();
    resetPolicyEngine();
    resetPermissionModeManager();
    getToolCache().clear();
    getPolicyEngine().loadUserRules({ ask: [buildRuleString({ tool: 'Bash', pattern: 'rm *' })] }, 'user-ui');
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPolicyEngine();
    resetPermissionModeManager();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function pendingRows() {
    return approvals.listByKindAndStatus('tool_approval', 'pending');
  }

  function fileExists() {
    return existsSync(path.join(dir, 'draft-2.txt'));
  }

  async function raiseApproval(parentToolUseId?: string, backgroundTaskLane = false) {
    const raised = Promise.withResolvers<PermissionRequest>();
    const island = new OrchestratorPermissionIsland({
      getSettings: () => DEFAULT_SETTINGS,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      isDetachedRun: () => detached,
      backgroundTaskLane,
      hasApprovalUi: () => hasUi,
      onEvent: (event) => {
        if (event.type === 'permission_request' && !event.data.resolved) raised.resolve(event.data);
      },
      injectedPendingApprovalRepo: approvals,
    });
    const executor = new ToolExecutor({
      workingDirectory: dir,
      requestPermission: (request) => island.requestPermission(request),
    });
    executor.setAuditEnabled(false);
    const execution = executor.execute('Bash', { command }, {
      sessionId, currentToolCallId: parentToolUseId,
    });
    const request = await Promise.race([
      raised.promise,
      execution.then((result) => { throw new Error(`Tool finished before asking: ${result.error ?? result.output}`); }),
    ]);
    return { island, execution, request };
  }

  it('(a) writes one ledger-faithful row at raise time', async () => {
    const { island, execution, request } = await raiseApproval(toolCallId, true);
    try {
      const rows = pendingRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(request.id);
      expect(JSON.parse(rows[0].payloadJson)).toMatchObject({
        argsRef: { sessionId, toolCallId },
        argsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        ledgerFaithful: true,
        backgroundLane: true,
      });
      expect(fileExists()).toBe(true);
    } finally {
      island.drainPendingPermissions();
      await execution;
    }
  });

  it.each([
    ['allow', 'approved', null],
    ['deny', 'rejected', null],
    ['drain', 'rejected', 'run cancelled'],
    ['supersede', 'rejected', 'superseded'],
    ['timeout', 'rejected', 'attended approval timed out'],
  ] as const)('(b) %s settles the mirror', async (exit, status, feedback) => {
    if (exit === 'timeout') {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      hasUi = false;
    }
    const { island, execution, request } = await raiseApproval(toolCallId);
    switch (exit) {
      case 'allow':
      case 'deny':
        expect(island.handlePermissionResponse(request.id, exit)).toBe('delivered');
        break;
      case 'drain':
        island.drainPendingPermissions();
        break;
      case 'supersede':
        island.supersedeInteractivePendingApprovals();
        break;
      case 'timeout':
        await vi.advanceTimersByTimeAsync(59_999);
        expect(approvals.getById(request.id)?.status).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        break;
    }
    expect((await execution).success).toBe(exit === 'allow');
    expect(approvals.getById(request.id)).toMatchObject({ status, feedback });
    expect(fileExists()).toBe(exit !== 'allow');
  });

  it('(c) parking after detachment replaces the same row', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const { island, execution, request } = await raiseApproval(toolCallId);
    const before = pendingRows().map(({ id, payloadJson }) => ({ id, payloadJson }));
    detached = true;
    await vi.advanceTimersByTimeAsync(15_000);
    try {
      expect(before).toHaveLength(1);
      expect(pendingRows().map(({ id, payloadJson }) => ({ id, payloadJson }))).toEqual(before);
      expect(island.listPendingRequests()[0]).toMatchObject({ id: request.id, argsPreview: command });
    } finally {
      island.drainPendingPermissions();
      await execution;
    }
  });

  it.each(['allow', 'deny'] as const)('(d) boot preserves an unanswered row and %s settles it once', async (response) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { request } = await raiseApproval(toolCallId);
    // Simulate process loss without draining the island. Reopen SQLite with fresh repositories.
    vi.clearAllTimers();
    vi.useRealTimers();
    db.close();
    openDatabase();

    const loadMessages = (id: string) => sessions.getMessages(id);
    const resolveWorkingDirectory = (id: string) => sessions.getSession(id)?.workingDirectory ?? null;
    const persistToolMessage = async (id: string, message: Message) => {
      sessions.addMessage(id, message);
    };
    const now = Date.now();
    const counts = hydrateApprovalGatesAtBoot(approvals, now, {
      loadSessionMessages: loadMessages, resolveWorkingDirectory, persistToolMessage, durableRunRepository: runs,
    });
    expect(counts.survived).toBe(1);
    expect(pendingRows()).toHaveLength(1);

    const executor = new ToolExecutor({ workingDirectory: dir, requestPermission: async () => true });
    executor.setAuditEnabled(false);
    const executeTool = vi.fn<ParkedApprovalResumePorts['executeTool']>((input) =>
      executor.execute(input.name, input.arguments, {
        sessionId: input.sessionId, currentToolCallId: input.toolCallId,
      }));
    const ports: ParkedApprovalResumePorts = {
      repo: approvals, loadMessages, resolveWorkingDirectory, persistToolMessage, executeTool,
      now: () => now, durableRunRepository: runs,
    };
    expect(await resumeSurvivingParkedApproval({ requestId: request.id, response, now, ports })).toMatchObject({
      handled: true, status: response === 'allow' ? 'executed' : 'denied',
    });
    expect(await resumeSurvivingParkedApproval({ requestId: request.id, response: 'allow', now, ports })).toEqual({
      handled: false,
    });
    expect(executeTool).toHaveBeenCalledTimes(response === 'allow' ? 1 : 0);
    expect(approvals.getById(request.id)?.status).toBe(response === 'allow' ? 'approved' : 'rejected');
    expect(fileExists()).toBe(response === 'deny');
    const results = loadMessages(sessionId).flatMap((message) => message.toolResults ?? []);
    expect(results).toMatchObject([{ toolCallId, success: response === 'allow' }]);
  });

  it('(e) skips requests without a parent tool call', async () => {
    const { island, execution, request } = await raiseApproval();
    try {
      expect(request.parentToolUseId).toBeUndefined();
      expect(approvals.getById(request.id)).toBeNull();
    } finally {
      island.drainPendingPermissions();
      await execution;
    }
  });
});
