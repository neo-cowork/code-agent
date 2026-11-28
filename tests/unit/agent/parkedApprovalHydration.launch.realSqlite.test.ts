// N-FIX-CRON-SPAWN-LAUNCH-APPROVAL-NOT-IN-INBOX-CORE ③：重启后的团队启动审批。
// cron / heartbeat 的运行不跨重启续跑，它留下的 launch 行在启动 hydrate 时直接拒掉；
// 交互会话的 launch 行照旧载回 pending。
//
// 行由生产入口写入真 SQLite（getSwarmLaunchApprovalGate().requestApproval），「重启」=
// vi.resetModules() 换一套全新的模块实例（新 gate、新权限档管理器，内存状态全丢），
// 再走生产启动入口 hydrateApprovalGatesAtBoot，会话来源用它的默认解析（读真会话行）。
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

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import type { Session } from '../../../src/shared/contract';

describe('team-launch approvals at boot (real SQLite, production hydrate entry)', () => {
  let tmpDir: string;
  let db: BetterSqlite3.Database;
  let approvals: PendingApprovalRepository;
  let sessions: SessionRepository;

  function createSession(id: string, originKind?: 'cron' | 'heartbeat' | 'channel'): void {
    const session: Session = {
      id,
      title: id,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' } as Session['modelConfig'],
      ...(originKind ? { origin: { kind: originKind, id: `job-${id}` } as Session['origin'] } : {}),
      createdAt: 1,
      updatedAt: 1,
    };
    sessions.createSession(session);
  }

  /** 上一个进程：经生产入口把 launch 审批停进库里，然后进程「死掉」（等待者永不返回）。 */
  async function parkLaunchInPreviousProcess(sessionIds: string[]): Promise<Map<string, string>> {
    const { AppWindow } = await import('../../../src/host/platform');
    vi.spyOn(AppWindow, 'getAllWindows').mockReturnValue([{} as never]);
    const { getSwarmLaunchApprovalGate } = await import('../../../src/host/agent/swarmLaunchApproval');
    const gate = getSwarmLaunchApprovalGate();
    gate.attachPersistence(approvals);
    const ids = new Map<string, string>();
    for (const sessionId of sessionIds) {
      const scope = { sessionId, runId: `run-${sessionId}`, treeId: `tree-${sessionId}` };
      void gate.requestApproval({
        scope,
        tasks: [{ id: 'writer', role: 'coder', task: 'write the weekly report', tools: ['Write'], writeAccess: true }],
      });
      const [request] = gate.getPendingRequests(scope);
      expect(request, `launch parked for ${sessionId}`).toBeTruthy();
      ids.set(sessionId, request.id);
    }
    return ids;
  }

  const rowById = (id: string) => (['pending', 'approved', 'rejected', 'orphaned'] as const)
    .flatMap((status) => approvals.listByKindAndStatus('launch', status))
    .find((row) => row.id === id);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-approval-boot-'));
    db = new Database(path.join(tmpDir, 'code-agent.db'));
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    applySchema(db, quiet as never);
    applySessionsMigrations(db, quiet as never);
    approvals = new PendingApprovalRepository(db);
    sessions = new SessionRepository(db);
    dbState.approvals = approvals;
    dbState.sessions = sessions;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dbState.approvals = null;
    dbState.sessions = null;
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('cron and heartbeat rows are rejected at boot; interactive and channel rows stay pending', async () => {
    createSession('sess-cron', 'cron');
    createSession('sess-heartbeat', 'heartbeat');
    createSession('sess-channel', 'channel');
    createSession('sess-interactive');
    const ids = await parkLaunchInPreviousProcess(['sess-cron', 'sess-heartbeat', 'sess-channel', 'sess-interactive']);
    for (const id of ids.values()) expect(rowById(id)?.status).toBe('pending');

    // 进程重启：模块实例全换，内存里的 gate / 权限档标记都没了，只剩库里的行。
    vi.resetModules();
    const { hydrateApprovalGatesAtBoot } = await import('../../../src/host/agent/parkedApprovalHydration');
    const { getSwarmLaunchApprovalGate } = await import('../../../src/host/agent/swarmLaunchApproval');
    const { SessionAutomationService } = await import('../../../src/host/services/sessionAutomation/sessionAutomationService');
    const bootAt = Date.now() + 5_000;

    const counts = hydrateApprovalGatesAtBoot(approvals, bootAt);

    for (const sessionId of ['sess-cron', 'sess-heartbeat']) {
      const row = rowById(ids.get(sessionId)!);
      expect(row?.status, sessionId).toBe('rejected');
      expect(row?.feedback, sessionId).toMatch(/^Auto-rejected after restart/);
      expect(row?.resolvedAt, sessionId).toBe(bootAt);
    }
    for (const sessionId of ['sess-channel', 'sess-interactive']) {
      const row = rowById(ids.get(sessionId)!);
      expect(row?.status, sessionId).toBe('pending');
      expect(row?.feedback ?? null, sessionId).toBeNull();
    }
    // 新进程的 gate 只载回没被作废的两条；收件箱同样只剩它们。
    expect(counts.launch).toBe(2);
    expect(getSwarmLaunchApprovalGate().getPendingRequests().map((request) => request.sessionId).sort())
      .toEqual(['sess-channel', 'sess-interactive']);
    expect(new SessionAutomationService().listParkedApprovals()
      .filter((item) => item.kind === 'launch').map((item) => item.sessionId).sort())
      .toEqual(['sess-channel', 'sess-interactive']);
  });

  it('a second boot leaves the already rejected cron row untouched', async () => {
    createSession('sess-cron', 'cron');
    const ids = await parkLaunchInPreviousProcess(['sess-cron']);
    vi.resetModules();
    const first = await import('../../../src/host/agent/parkedApprovalHydration');
    first.hydrateApprovalGatesAtBoot(approvals, 10_000);
    const afterFirst = rowById(ids.get('sess-cron')!);

    vi.resetModules();
    const second = await import('../../../src/host/agent/parkedApprovalHydration');
    second.hydrateApprovalGatesAtBoot(approvals, 20_000);

    expect(rowById(ids.get('sess-cron')!)).toEqual(afterFirst);
    expect(afterFirst).toMatchObject({ status: 'rejected', resolvedAt: 10_000 });
  });
});
