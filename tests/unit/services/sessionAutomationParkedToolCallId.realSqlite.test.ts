// N-FIX-PARKED-APPROVAL-SESSION-SHOWS-RUNNING ③：listParkedApprovals 交出 toolCallId。
// 行由生产停车路径（OrchestratorPermissionIsland.requestPermission → parkApproval）写入真 SQLite；
// 老行（payload 没有 toolCallId/argsRef）不带该字段。
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const dbState = vi.hoisted(() => ({ repo: null as unknown }));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getPendingApprovalRepo: () => dbState.repo }),
}));
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  const stub = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => stub() });
  return { ...actual, createLogger: () => stub() };
});
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

import type { AppSettings } from '../../../src/shared/contract';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { SessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';

// 只有 permissions 影响停车路径；Partial<AppSettings> 是真实形状的子集，再收口到 AppSettings。
function settingsWithPermissions(permissions: AppSettings['permissions']): AppSettings {
  const partial: Partial<AppSettings> = { permissions };
  return partial as AppSettings;
}

describe('listParkedApprovals toolCallId (real SQLite)', () => {
  let dir: string;
  let db: BetterSqlite3.Database;
  let approvals: PendingApprovalRepository;

  beforeEach(() => {
    resetPermissionModeManager();
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'parked-toolcallid-')));
    db = new Database(path.join(dir, 'test.db'));
    applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
    approvals = new PendingApprovalRepository(db);
    dbState.repo = approvals;
  });
  afterEach(() => {
    resetPermissionModeManager();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('生产停车路径落库的行 → 列表项带 toolCallId', () => {
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settingsWithPermissions({
        autoApprove: { read: false, write: false, execute: false, network: false },
        blockedCommands: [],
        devModeAutoApprove: false,
      }),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => false,
      onEvent: vi.fn(),
      injectedPendingApprovalRepo: approvals,
    });
    getPermissionModeManager().markUnattendedSession('sess-real');
    void island.requestPermission({
      type: 'command', tool: 'Bash', details: { command: 'echo hi' },
      sessionId: 'sess-real', parentToolUseId: 'toolu_REAL1',
    });
    const items = new SessionAutomationService().listParkedApprovals();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionId: 'sess-real', status: 'pending', toolCallId: 'toolu_REAL1' });
  });

  it('老行（payload 无 toolCallId / argsRef）→ 不带该字段', () => {
    approvals.insert({
      id: 'legacy', kind: 'tool_approval', agentId: null, agentName: null, coordinatorId: 'sess-old',
      payload: { sessionId: 'sess-old', tool: 'Bash', requestedAt: 1_000 } as never,
      submittedAt: 1_000,
    });
    const items = new SessionAutomationService().listParkedApprovals();
    expect(items).toHaveLength(1);
    expect('toolCallId' in items[0]).toBe(false);
  });
});
