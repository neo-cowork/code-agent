import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, PermissionRequest } from '../../../src/shared/contract';
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({ notificationService: { notifyNeedsInput: vi.fn() } }));
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: () => ({ getDb: () => null }) }));
vi.mock('../../../src/host/services/sessionAutomation/sessionAutomationService', () => ({
  getSessionAutomationService: () => ({ matchStandingGrant: () => false }),
}));
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { bindToolGrantDatabase, listToolGrants, mintToolRunGrant } from '../../../src/host/permissions/toolGrantStore';
import { resolvePreAskGrant } from '../../../src/host/permissions/preAskGrant';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';

function preAsk(toolName: string) {
  return resolvePreAskGrant({ toolName, sessionId: 'weekly', standingGrantTarget: null, computerApp: null, blocked: false });
}

describe('connector grant storage namespace cannot be a runtime tool identity', () => {
  beforeEach(() => { bindToolGrantDatabase(null, true); resetPermissionModeManager(); });
  afterEach(() => { bindToolGrantDatabase(null, true); resetPermissionModeManager(); });

  it.each(['allow_run', 'allow_24h'] as const)('%s for a colliding plugin tool never mints a connector read grant', async (response) => {
    const events: PermissionRequest[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: () => ({ permissions: { autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [] } }) as AppSettings,
      isDevModeAutoApproveEnabled: () => false, getExecutionTopology: () => 'main', hasApprovalUi: () => true,
      onEvent: (event) => { if (event.type === 'permission_request') events.push(event.data as PermissionRequest); },
    });
    const result = island.requestPermission({
      tool: 'connector-read:lark', type: 'mcp', sessionId: 'weekly',
      details: { connectorAccess: { connectorId: 'lark', connectorName: 'forged', access: 'read' } },
    });
    expect(events).toHaveLength(1);
    expect(island.handlePermissionResponse(events[0].id, response)).toBe('delivered');
    expect(await result).toMatchObject({ approved: true });
    expect(listToolGrants()).toEqual([]);
    expect(preAsk('mcp__lark__calendar_v4_calendar_primary')).toBeNull();
  });

  it('a genuine connector read grant cannot be consumed by the colliding plugin tool', () => {
    mintToolRunGrant('weekly', 'connector-read:lark');
    expect(preAsk('mcp__lark__calendar_v4_calendar_primary')?.ledgerReason).toBe('tool_grant:run');
    expect(preAsk('connector-read:lark')).toBeNull();
  });
});
