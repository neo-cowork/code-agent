// 停车时 host 已校验的 details.targetApp 必须随行落盘（重启后 allow_24h 只读这份身份）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { vi } from 'vitest';

// 只隔离通知副作用，免得本文件的真停车污染同 worker 的通知链测试。
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notify: vi.fn(), retractNeedsInput: vi.fn(), notifyNeedsInput: vi.fn(), clearRecentNotifications: vi.fn() },
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';

describe('parked approval persists targetApp', () => {
  let db: BetterSqlite3.Database;
  let island: OrchestratorPermissionIsland;
  let repo: PendingApprovalRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE pending_approvals (
      id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
      payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT)`);
    repo = new PendingApprovalRepository(db);
    island = new OrchestratorPermissionIsland({
      getSettings: () => ({ permissions: { autoApprove: {} } }) as never,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent: () => {},
      injectedPendingApprovalRepo: repo,
    });
  });
  afterEach(async () => {
    island.drainPendingPermissions();
    resetPermissionModeManager();
    db.close();
  });

  it('row payload carries the host-resolved targetApp', async () => {
    getPermissionModeManager().markUnattendedSession('s-app');
    const pending = island.requestPermission({
      type: 'command',
      tool: 'mcp__cua-driver__click',
      sessionId: 's-app',
      parentToolUseId: 'call-1',
      reason: 'needs confirm',
      details: { targetApp: { name: 'Notes', bundleId: 'com.apple.Notes' } },
    });
    const row = repo.listByKindAndStatus('tool_approval', 'pending')[0];
    expect(JSON.parse(row.payloadJson).targetApp).toEqual({ name: 'Notes', bundleId: 'com.apple.Notes' });
    island.drainPendingPermissions();
    await pending;
  });
});
