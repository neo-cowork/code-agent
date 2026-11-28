// N-FIX-CRON-SPAWN-LAUNCH-APPROVAL-NOT-IN-INBOX-CORE：无人值守会话的团队启动审批
// 进待过目收件箱、可在收件箱批准/拒绝、到期自动拒且定时任务不被停用。
//
// 全走生产入口：getSwarmLaunchApprovalGate().requestApproval → 临时目录里的真 SQLite（真
// schema + 真 PendingApprovalRepository / SessionRepository）→ SessionAutomationService
// .listParkedApprovals → installPermissionResponseHandler 返回的投递函数。
// 被替换的只有两处：平台窗口列表（1 个窗口，否则走 headless 自动批），以及 getDatabase 的
// 取实例口——DatabaseService 本体在 vitest 的 CLI 模式下装不了 better-sqlite3，所以与仓内
// 其它 *.realSqlite 测试同一做法：它只把上面两个真仓储原样交出去。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const dbState = vi.hoisted(() => ({
  approvals: null as unknown,
  sessions: null as { getSession: (id: string) => unknown } | null,
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getPendingApprovalRepo: () => {
      if (!dbState.approvals) throw new Error('database not ready');
      return dbState.approvals;
    },
    getSession: (sessionId: string) => dbState.sessions?.getSession(sessionId) ?? null,
  }),
}));

import { AppWindow } from '../../../src/host/platform';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { getSwarmLaunchApprovalGate, type SwarmLaunchApprovalResult } from '../../../src/host/agent/swarmLaunchApproval';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { SessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';
import { installPermissionResponseHandler } from '../../../src/web/webPermissionResponseHandler';
import { notificationService } from '../../../src/host/services/infra/notificationService';
import {
  takeUnattendedApprovalDenials,
  takeUnattendedApprovalTimeout,
} from '../../../src/host/agent/unattendedApprovalTerminal';
import { INTERACTION_TIMEOUTS } from '../../../src/shared/constants/timeouts';
import type { Session } from '../../../src/shared/contract';
import type { SwarmRunScope } from '../../../src/shared/contract/swarm';

type OriginKind = 'cron' | 'heartbeat' | 'channel';
type LogFn = ReturnType<typeof vi.fn<(message: string, ...args: unknown[]) => void>>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('unattended team-launch approval (real SQLite, production entries)', () => {
  let tmpDir: string;
  let db: BetterSqlite3.Database;
  let approvals: PendingApprovalRepository;
  let sessions: SessionRepository;
  let logger: { info: LogFn; warn: LogFn };
  let deliver: ReturnType<typeof installPermissionResponseHandler>;
  let counter = 0;

  const scopeFor = (sessionId: string): SwarmRunScope => ({
    sessionId,
    runId: `run-${sessionId}`,
    treeId: `tree-${sessionId}`,
  });

  /** 建一条真会话行，并按 sessionManager 建会话收口处的同一规则打无人值守标记。 */
  function createSession(title: string, originKind?: OriginKind): string {
    const sessionId = `sess-launch-${++counter}`;
    const session: Session = {
      id: sessionId,
      title,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' } as Session['modelConfig'],
      ...(originKind ? { origin: { kind: originKind, id: `job-${sessionId}` } as Session['origin'] } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    sessions.createSession(session);
    const modes = getPermissionModeManager();
    if (originKind) {
      modes.markUnattendedSession(sessionId);
      if (originKind !== 'channel') modes.markUnattendedApprovalDegrade(sessionId);
    }
    return sessionId;
  }

  function requestLaunch(sessionId: string): Promise<SwarmLaunchApprovalResult> {
    return getSwarmLaunchApprovalGate().requestApproval({
      scope: scopeFor(sessionId),
      tasks: [{ id: 'writer', role: 'coder', task: 'Turn notes.txt into weekly-report.md', tools: ['Write'], writeAccess: true }],
    });
  }

  const pendingLaunchId = (sessionId: string): string => {
    const [request] = getSwarmLaunchApprovalGate().getPendingRequests(scopeFor(sessionId));
    expect(request, `pending launch for ${sessionId}`).toBeTruthy();
    return request.id;
  };

  const launchRow = (requestId: string) => {
    return (['pending', 'approved', 'rejected', 'orphaned'] as const)
      .flatMap((status) => approvals.listByKindAndStatus('launch', status))
      .find((row) => row.id === requestId);
  };

  beforeEach(() => {
    resetPermissionModeManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-approval-inbox-'));
    db = new Database(path.join(tmpDir, 'code-agent.db'));
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    applySchema(db, quiet as never);
    applySessionsMigrations(db, quiet as never);
    approvals = new PendingApprovalRepository(db);
    sessions = new SessionRepository(db);
    dbState.approvals = approvals;
    dbState.sessions = sessions;
    vi.spyOn(AppWindow, 'getAllWindows').mockReturnValue([{} as AppWindow]);
    getSwarmLaunchApprovalGate().attachPersistence(approvals);
    logger = { info: vi.fn(), warn: vi.fn() };
    deliver = installPermissionResponseHandler({
      handlers: new Map(),
      pendingDevPermissions: new Map(),
      getCurrentSessionId: () => null,
      logger,
    });
  });

  afterEach(() => {
    getSwarmLaunchApprovalGate().cancelAll('test teardown');
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetPermissionModeManager();
    dbState.approvals = null;
    dbState.sessions = null;
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('① inbox listing and delivery', () => {
    it('listParkedApprovals returns the pending launch as a kind=launch row with session title and member count', async () => {
      const sessionId = createSession('[Schedule] Weekly report', 'cron');
      void requestLaunch(sessionId);
      const requestId = pendingLaunchId(sessionId);

      const items = new SessionAutomationService().listParkedApprovals();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: requestId,
        kind: 'launch',
        sessionId,
        sessionTitle: 'Weekly report',
        status: 'pending',
        launchMemberCount: 1,
      });
      // 运行记录侧同一条审批：这次运行显示为「等你确认」，而不是一直「运行中」。
      expect(new SessionAutomationService().listAwaitingApprovalRuns()).toEqual([
        expect.objectContaining({ jobId: `job-${sessionId}`, requestId, sessionId }),
      ]);
    });

    it("'allow' through the installed permission-response handler resolves the request approved", async () => {
      const sessionId = createSession('[Schedule] Weekly report', 'cron');
      const decision = requestLaunch(sessionId);
      const requestId = pendingLaunchId(sessionId);

      const result = await deliver(requestId, 'allow', sessionId);

      expect(result).toMatchObject({ success: true, data: { requestId, sessionId, decision: 'approved' } });
      await expect(decision).resolves.toMatchObject({ approved: true, autoApproved: false });
      expect(launchRow(requestId)?.status).toBe('approved');
      expect(new SessionAutomationService().listParkedApprovals()).toEqual([]);
      expect(logger.info).toHaveBeenCalledWith(
        'Team launch approval response delivered (web)',
        expect.objectContaining({ requestId, sessionId, decision: 'approved' }),
      );
    });

    it("'deny' through the installed permission-response handler resolves the request rejected", async () => {
      const sessionId = createSession('[Schedule] Weekly report', 'cron');
      const decision = requestLaunch(sessionId);
      const requestId = pendingLaunchId(sessionId);

      const result = await deliver(requestId, 'deny', sessionId);

      expect(result).toMatchObject({ success: true, data: { requestId, sessionId, decision: 'rejected' } });
      const settled = await decision;
      expect(settled.approved).toBe(false);
      expect(settled.feedback).toBe('Rejected by the user in the review inbox. Do not retry this team launch.');
      expect(launchRow(requestId)).toMatchObject({ status: 'rejected', feedback: settled.feedback });
      expect(new SessionAutomationService().listParkedApprovals()).toEqual([]);
      // 用户亲手拒绝不是「没人应答」：不记降级拒绝。
      expect(takeUnattendedApprovalDenials(sessionId)).toEqual([]);
    });

    it('a response carrying another sessionId is not delivered and the row stays pending', async () => {
      const sessionId = createSession('[Schedule] Weekly report', 'cron');
      const other = createSession('[Schedule] Another job', 'cron');
      const decision = requestLaunch(sessionId);
      const requestId = pendingLaunchId(sessionId);
      let settled = false;
      void decision.then(() => { settled = true; });

      const result = await deliver(requestId, 'allow', other);

      expect(result).toMatchObject({ success: false, error: { code: 'LAUNCH_APPROVAL_SESSION_MISMATCH' } });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(launchRow(requestId)?.status).toBe('pending');
      expect(getSwarmLaunchApprovalGate().getPendingRequests(scopeFor(sessionId))).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'Team launch approval response not delivered: session mismatch (web)',
        expect.objectContaining({ requestId, sessionId: other, ownerSessionId: sessionId }),
      );
    });

    it('a response carrying edited arguments is refused and the row stays pending', async () => {
      const sessionId = createSession('[Schedule] Weekly report', 'cron');
      void requestLaunch(sessionId);
      const requestId = pendingLaunchId(sessionId);
      const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
      installPermissionResponseHandler({
        handlers,
        pendingDevPermissions: new Map(),
        getCurrentSessionId: () => null,
        logger,
      });
      const [handler] = [...handlers.values()];

      const result = await handler(null, requestId, 'allow', sessionId, { agents: [] });

      expect(result).toMatchObject({ success: false, error: { code: 'LAUNCH_APPROVAL_NOT_EDITABLE' } });
      expect(launchRow(requestId)?.status).toBe('pending');
    });
  });

  describe('② expiry and notification', () => {
    let notify: ReturnType<typeof vi.spyOn<typeof notificationService, 'notifyNeedsInput'>>;
    let retract: ReturnType<typeof vi.spyOn<typeof notificationService, 'retractNeedsInput'>>;

    beforeEach(() => {
      vi.useFakeTimers();
      notify = vi.spyOn(notificationService, 'notifyNeedsInput').mockImplementation(() => undefined);
      retract = vi.spyOn(notificationService, 'retractNeedsInput').mockImplementation(() => undefined);
    });

    /** 通知服务是按需加载的：等它装载完，停车通知才发得出去。 */
    const parked = async () => { await vi.dynamicImportSettled(); };

    it.each(['cron', 'heartbeat'] as const)('%s session: rejected after 30 minutes, denial recorded, no permanent-failure code', async (originKind) => {
      const sessionId = createSession('[Schedule] Weekly report', originKind);
      const decision = requestLaunch(sessionId);
      const requestId = pendingLaunchId(sessionId);
      await parked();

      await vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUTS.UNATTENDED_PARKED_APPROVAL_DEGRADE - 1);
      expect(launchRow(requestId)?.status).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);

      const settled = await decision;
      expect(settled.approved).toBe(false);
      expect(settled.feedback).toBe(
        'Auto-rejected: nobody approved this team launch within 30 minutes. Do not retry the launch. '
        + 'Finish the task yourself with the tools you already have, and state in your final report '
        + 'that no team member was sent because nobody approved in time.',
      );
      expect(launchRow(requestId)).toMatchObject({ status: 'rejected', feedback: settled.feedback });
      const denials = takeUnattendedApprovalDenials(sessionId);
      expect(denials).toHaveLength(1);
      expect(denials[0]).toMatchObject({ tool: 'spawn_agent', code: 'TEAM_LAUNCH_APPROVAL_EXPIRED' });
      // cronFailurePolicy 把 UNATTENDED_APPROVAL_TIMEOUT 当永久失败并停用任务：这里绝不能写它。
      expect(takeUnattendedApprovalTimeout(sessionId)).toBeUndefined();
      expect(`${settled.feedback} ${denials[0].code}`).not.toMatch(/UNATTENDED_APPROVAL_TIMEOUT|DOOM_LOOP_HANDBACK_STOP/);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ sessionId, dedupeKey: requestId }));
      await parked();
      expect(retract).toHaveBeenCalledTimes(1);
      expect(retract).toHaveBeenCalledWith(requestId);
    });

    it('channel-origin unattended session: still pending after 30 minutes, rejected at 24 hours', async () => {
      const sessionId = createSession('[Channel] Team chat', 'channel');
      const decision = requestLaunch(sessionId);
      const requestId = pendingLaunchId(sessionId);
      await parked();

      await vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUTS.PARKED_APPROVAL - 1);
      expect(launchRow(requestId)?.status).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);

      const settled = await decision;
      expect(settled.approved).toBe(false);
      expect(settled.feedback).toContain('within 1440 minutes');
      expect(launchRow(requestId)?.status).toBe('rejected');
      expect(notify).toHaveBeenCalledTimes(1);
      await parked();
      expect(retract).toHaveBeenCalledWith(requestId);
    });

    it('interactive session: still pending after 25 hours, never notified', async () => {
      const sessionId = createSession('Plan the offsite');
      let settled = false;
      void requestLaunch(sessionId).then(() => { settled = true; });
      const requestId = pendingLaunchId(sessionId);
      await parked();

      await vi.advanceTimersByTimeAsync(25 * HOUR);

      expect(settled).toBe(false);
      expect(launchRow(requestId)?.status).toBe('pending');
      expect(notify).not.toHaveBeenCalled();
      expect(retract).not.toHaveBeenCalled();
    });

    it.each([
      ['approve', (id: string) => { getSwarmLaunchApprovalGate().approve(id); }],
      ['reject', (id: string) => { getSwarmLaunchApprovalGate().reject(id, 'no'); }],
      ['cancelAll', () => { getSwarmLaunchApprovalGate().cancelAll('shutdown'); }],
      ['cancelRun', (_id: string, sessionId: string) => { getSwarmLaunchApprovalGate().cancelRun(scopeFor(sessionId), 'parent-cancel'); }],
      ['cancelSession', (_id: string, sessionId: string) => { getSwarmLaunchApprovalGate().cancelSession(sessionId, 'user-cancel'); }],
    ] as const)('%s withdraws the notification and stops the expiry timer', async (_name, settle) => {
      const sessionId = createSession('[Schedule] Weekly report', 'cron');
      const decision = requestLaunch(sessionId);
      const requestId = pendingLaunchId(sessionId);
      await parked();
      expect(notify).toHaveBeenCalledTimes(1);

      settle(requestId, sessionId);
      const first = await decision;
      await parked();
      expect(retract).toHaveBeenCalledTimes(1);
      expect(retract).toHaveBeenCalledWith(requestId);

      // 计时器已清：再过一小时不会有第二次结算，也不会补记「没人应答」。
      const rowAfterSettle = launchRow(requestId);
      await vi.advanceTimersByTimeAsync(HOUR);
      expect(launchRow(requestId)).toEqual(rowAfterSettle);
      expect(first.feedback ?? '').not.toContain('nobody approved');
      expect(takeUnattendedApprovalDenials(sessionId)).toEqual([]);
      expect(retract).toHaveBeenCalledTimes(1);
    });

    it('settling before the notification service has loaded sends no notification at all', async () => {
      const sessionId = createSession('[Schedule] Weekly report', 'cron');
      const decision = requestLaunch(sessionId);
      const requestId = pendingLaunchId(sessionId);

      getSwarmLaunchApprovalGate().approve(requestId);
      await decision;
      await parked();

      expect(notify).not.toHaveBeenCalled();
      expect(retract).not.toHaveBeenCalled();
      expect(30 * MINUTE).toBe(INTERACTION_TIMEOUTS.UNATTENDED_PARKED_APPROVAL_DEGRADE);
    });
  });
});
