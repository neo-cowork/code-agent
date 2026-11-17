import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import { setTimeout as realDelay } from 'node:timers/promises';
import path from 'node:path';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { AppSettings } from '../../../../src/shared/contract';
import type { SessionRepository } from '../../../../src/host/services/core/repositories/SessionRepository';
import type { PendingApprovalRepository } from '../../../../src/host/services/core/repositories/PendingApprovalRepository';

const state = vi.hoisted(() => ({
  dir: '', db: null as Database.Database | null,
  sessions: null as SessionRepository | null, approvals: null as PendingApprovalRepository | null,
  sessionId: '', send: vi.fn(), cancel: vi.fn(), warn: vi.fn(), info: vi.fn(),
}));
vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => state.dir,
  getAgentsMdDir: () => ({ user: path.join(state.dir, 'agents') }),
}));
vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => state.db, getSession: (id: string) => state.sessions?.getSession(id),
    getPendingApprovalRepo: () => state.approvals,
    getRecentMessages: () => [],
  }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ warn: state.warn, info: state.info, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));
vi.mock('../../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getCurrentSessionId: () => null,
    createSession: async (options: Parameters<SessionRepository['createSessionWithId']>[1]) => {
      // The origin is supplied by wakeRole, never authored by this test.
      const id = `wake-created-by-production-${(state.db!.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n}`;
      state.sessions!.createSessionWithId(id, options);
      const session = state.sessions!.getSession(id)!;
      state.sessionId = session.id;
      const mode = getPermissionModeManager();
      mode.markUnattendedSession(session.id);
      mode.markUnattendedApprovalDegrade(session.id);
      return session;
    },
    getSession: async (id: string) => ({
      ...state.sessions!.getSession(id), messages: [{
        id: 'summary', role: 'assistant', content: 'Three notes summarized.<decision>report</decision>', timestamp: Date.now(),
      }],
    }),
    updateMessage: vi.fn(), archiveSession: vi.fn(),
  }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ roleAssets: { proactivity: { defaultLevel: 'daily' } } }) }),
}));
vi.mock('../../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({ provider: 'openai', model: 'test' }),
}));
vi.mock('../../../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));
vi.mock('../../../../src/host/services/capabilities/capabilityCenterService', () => ({
  getCapabilityCenterService: () => ({ listCapabilities: async () => ({ items: [] }) }),
}));
vi.mock('../../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => ({ sendMessage: state.send, cancel: state.cancel }),
    setWorkingDirectory: vi.fn(), cleanup: vi.fn(),
  }),
}));
vi.mock('../../../../src/host/services/roleAssets/roleWriteBack', () => ({ runRoleWriteBack: async () => undefined }));
vi.mock('../../../../src/host/hooks', () => ({ createHookManager: () => ({ initialize: vi.fn(), hasHooksFor: () => false }) }));

import { SessionRepository as Sessions } from '../../../../src/host/services/core/repositories/SessionRepository';
import { PendingApprovalRepository as Approvals } from '../../../../src/host/services/core/repositories/PendingApprovalRepository';
import { applyTestSessionSchema } from '../../../utils/applyTestSessionSchema';
import { SessionAutomationService } from '../../../../src/host/services/sessionAutomation/sessionAutomationService';
import { ensureRoleAssetDirs, appendRoleHistory } from '../../../../src/host/services/roleAssets/roleAssetService';
import { wakeRole } from '../../../../src/host/services/roleAssets/roleProactivity';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../../src/host/permissions/modes';
import { OrchestratorPermissionIsland } from '../../../../src/host/agent/orchestratorPermissions';
import { DEFAULT_SETTINGS } from '../../../../src/host/services/core/configDefaults';
import { INTERACTION_TIMEOUTS, ROLE_PROACTIVITY } from '../../../../src/shared/constants';
import { cronRunRecordZh, cronRunRecordEn } from '../../../../src/renderer/i18n/cronRunRecord';
import { deriveCronRunStatusLine } from '../../../../src/renderer/components/features/chat/cronRunSessionStatus';

const ROLE = 'morning-notes';
let island: OrchestratorPermissionIsland;
let service: SessionAutomationService;
let requestId: string;
let runningWake: ReturnType<typeof wakeRole> | undefined;

async function waitForParking(): Promise<void> {
  for (let i = 0; i < 100 && !requestId; i++) await realDelay(5);
  expect(requestId).toBeTruthy();
}

describe('production role wake approval visibility and deadline', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetPermissionModeManager();
    requestId = '';
    runningWake = undefined;
    state.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-approval-'));
    state.db = new Database(':memory:');
    applyTestSessionSchema(state.db);
    state.sessions = new Sessions(state.db);
    state.approvals = new Approvals(state.db);
    service = new SessionAutomationService();
    await ensureRoleAssetDirs(ROLE);
    await appendRoleHistory(ROLE, { date: new Date().toISOString().slice(0, 10), artifactLabel: 'Meeting notes', artifactRef: 'notes.md', summary: 'Write the morning summary' });
    island = new OrchestratorPermissionIsland({
      getSettings: () => DEFAULT_SETTINGS as AppSettings,
      isDevModeAutoApproveEnabled: () => false, getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false, injectedPendingApprovalRepo: state.approvals,
      onEvent: (event) => { if (event.type === 'permission_request') requestId = (event.data as { id: string }).id; },
    });
    state.send.mockImplementation(async () => {
      await island.requestPermission({ type: 'file_write', tool: 'Write', sessionId: state.sessionId, details: { path: 'notes/morning-summary.md' } });
    });
  });
  afterEach(async () => {
    island.drainPendingPermissions();
    await runningWake?.catch(() => undefined);
    vi.useRealTimers();
    resetPermissionModeManager();
    state.db?.close();
    await fs.rm(state.dir, { recursive: true, force: true });
  });

  it.each(['cadence', 'event'] as const)('production %s wake without job id enters listing and real status-line derivation; answering completes its record', async (trigger) => {
    const running = runningWake = wakeRole(ROLE, trigger);
    await waitForParking();
    const session = state.sessions!.getSession(state.sessionId)!;
    expect(session.origin?.id).toBeUndefined();
    const [row] = service.listAwaitingApprovalRuns();
    expect(row).toMatchObject({ runKind: 'role_wake', runKey: session.id, sessionId: session.id, requestId });
    expect(row.jobId).toBeUndefined();
    expect(deriveCronRunStatusLine({ execution: null, wakeRun: service.getRoleWakeRun(session.id), pendingApproval: { id: row.requestId, requestedAt: row.requestedAt } })?.kind).toBe('awaiting');
    service.listAwaitingApprovalRuns();
    expect(state.warn).not.toHaveBeenCalledWith('Awaiting-approval run skipped: session origin has no job id', expect.anything());
    island.handlePermissionResponse(requestId, 'allow');
    await expect(running).resolves.toMatchObject({ status: 'completed', sessionId: session.id });
    expect(service.getRoleWakeRun(session.id)?.run.status).toBe('completed');
    expect(service.listAwaitingApprovalRuns()).toEqual([]);
  });

  it('production parkApproval degrades an unanswered wake after 30 minutes; wake budget does not preempt it and the stored run leaves running', async () => {
    vi.useFakeTimers();
    const timed = runningWake = wakeRole(ROLE, 'event');
    await waitForParking();
    await vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUTS.UNATTENDED_PARKED_APPROVAL_DEGRADE - 1);
    expect(state.approvals!.getById(requestId)?.status).toBe('pending');
    expect(service.getRoleWakeRun(state.sessionId)?.run.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    await timed;
    vi.useRealTimers();
    const row = state.approvals!.getById(requestId)!;
    process.stdout.write(`RAW_DEGRADE_LOG ${String(state.warn.mock.calls.find(([message]) => String(message).includes('unanswered, degrading to deny'))?.[0])}\n`);
    process.stdout.write(`RAW_DEGRADE_ROW ${JSON.stringify(row)}\n`);
    process.stdout.write(`RAW_WAKE_RUN ${JSON.stringify(service.getRoleWakeRun(state.sessionId))}\n`);
    expect(row.status).toBe('rejected');
    expect(row.feedback).toContain('UNATTENDED_APPROVAL_TIMEOUT');
    expect(state.warn).toHaveBeenCalledWith(`Unattended parked approval ${requestId} unanswered, degrading to deny`);
    expect(state.cancel).not.toHaveBeenCalled();
    const wakeRun = service.getRoleWakeRun(state.sessionId)!;
    expect(wakeRun.run.status).toBe('completed');
    expect(deriveCronRunStatusLine({ execution: null, pendingApproval: null, wakeRun })?.kind).toBe('approval-expired');
    expect(cronRunRecordZh.approvalExpired).toContain('这一步没有执行');
    expect(cronRunRecordEn.approvalExpired).toContain('This step was skipped');
    if (process.env.NEO_ROLE_WAKE_EVIDENCE_DIR) {
      await fs.writeFile(path.join(process.env.NEO_ROLE_WAKE_EVIDENCE_DIR, 'degrade-proof.json'), JSON.stringify({
        log: state.warn.mock.calls.find(([message]) => String(message).includes('unanswered, degrading to deny'))?.[0],
        pending_approvals: row, wakeRun,
        statusLine: deriveCronRunStatusLine({ execution: null, pendingApproval: null, wakeRun }),
        visibleCopy: { zh: cronRunRecordZh.approvalExpired, en: cronRunRecordEn.approvalExpired },
      }, null, 2));
    }
    expect(INTERACTION_TIMEOUTS.UNATTENDED_PARKED_APPROVAL_DEGRADE).toBeGreaterThan(ROLE_PROACTIVITY.WAKE_TIMEOUT_MS);
  });

  it('a failed production wake closes its visible record instead of leaving it running', async () => {
    state.send.mockRejectedValueOnce(new Error('source unavailable'));
    await expect(wakeRole(ROLE, 'event')).rejects.toThrow('source unavailable');
    expect(service.getRoleWakeRun(state.sessionId)?.run.status).toBe('failed');
  });

  it('malformed cron origins still warn once per pending session per service, then reset when resolved', async () => {
    state.sessions!.createSessionWithId('broken', { title: 'Morning notes', modelConfig: { provider: 'openai', model: 'test' }, origin: { kind: 'cron' } });
    const session = state.sessions!.getSession('broken')!;
    state.approvals!.insert({ id: 'broken-request', kind: 'tool_approval', agentId: null, agentName: null, coordinatorId: session.id, payload: { sessionId: session.id, tool: 'Write' }, submittedAt: 1 });
    service.listAwaitingApprovalRuns();
    service.listAwaitingApprovalRuns();
    expect(state.warn.mock.calls.filter(([message]) => message === 'Awaiting-approval run skipped: session origin has no job id')).toHaveLength(1);
    state.approvals!.resolve({ id: 'broken-request', status: 'rejected', feedback: null, resolvedAt: Date.now() });
    service.listAwaitingApprovalRuns();
    state.approvals!.insert({ id: 'next-request', kind: 'tool_approval', agentId: null, agentName: null, coordinatorId: session.id, payload: { sessionId: session.id, tool: 'Write' }, submittedAt: 2 });
    service.listAwaitingApprovalRuns();
    expect(state.warn.mock.calls.filter(([message]) => message === 'Awaiting-approval run skipped: session origin has no job id')).toHaveLength(2);
  });
});
