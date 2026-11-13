import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { AppSettings, PermissionRequest, PermissionResponse } from '../../../src/shared/contract';
const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  session: null as { title?: string; origin?: { id: string } } | null,
  automation: null as { title: string } | null,
}));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({ notificationService: { notifyNeedsInput: vi.fn() } }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => state.db, getSession: () => state.session }),
}));
vi.mock('../../../src/host/services/sessionAutomation/sessionAutomationService', () => ({
  getSessionAutomationService: () => ({
    getBySourceRefId: () => state.automation,
    matchStandingGrant: () => false, listStandingGrantEntries: () => [],
  }),
}));
import { FEISHU_READONLY_TOOLS } from '../../../src/shared/constants/feishu';
import { classifyConnectorTool } from '../../../src/host/permissions/connectorToolAccess';
import { connectorApprovalDetails } from '../../../src/host/permissions/connectorApprovalDetails';
import { applyToolGrantsSchema } from '../../../src/host/services/core/database/schemaToolGrants';
import { bindToolGrantDatabase, listToolGrants } from '../../../src/host/permissions/toolGrantStore';
import { resolvePreAskGrant } from '../../../src/host/permissions/preAskGrant';
import { listGrants, revokeGrant } from '../../../src/host/permissions/grantLedger';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
const reads = FEISHU_READONLY_TOOLS.map((tool) => `mcp__lark__${tool.replace(/\./g, '_')}`);
const write = 'mcp__lark__calendar_v4_calendarEvent_create';
const forged = { connectorId: 'lark', connectorName: 'forged', access: 'read' as const };
function preAsk(toolName: string, sessionId = 'weekly', target: string | null = null) {
  return resolvePreAskGrant({ toolName, sessionId, standingGrantTarget: target, computerApp: null, blocked: false });
}
async function approve(tool: string, response: PermissionResponse, extra: Partial<PermissionRequest> = {}) {
  const events: PermissionRequest[] = [];
  const island = new OrchestratorPermissionIsland({
    getSettings: () => ({ permissions: { autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [] } }) as AppSettings,
    isDevModeAutoApproveEnabled: () => false, getExecutionTopology: () => 'main', hasApprovalUi: () => true,
    onEvent: (event) => { if (event.type === 'permission_request') events.push(event.data as PermissionRequest); },
  });
  const result = island.requestPermission({ tool, type: 'mcp', sessionId: 'weekly', details: {}, ...extra });
  expect(events).toHaveLength(1);
  expect(island.handlePermissionResponse(events[0].id, response)).toBe('delivered');
  expect(await result).toMatchObject({ approved: true });
  return events[0];
}
describe('Neo connector read/write approval boundary', () => {
  beforeEach(() => {
    state.db = new Database(':memory:');
    applyToolGrantsSchema(state.db, { info: vi.fn() } as never);
    bindToolGrantDatabase(state.db, true);
    state.session = null; state.automation = null;
    resetPermissionModeManager();
  });
  afterEach(() => { bindToolGrantDatabase(null, true); state.db?.close(); state.db = null; resetPermissionModeManager(); });
  it('classifies declared reads, undeclared writes, unknown and unlisted servers', () => {
    expect(reads).toHaveLength(6);
    expect(classifyConnectorTool(reads[0])).toEqual({ connectorId: 'lark', connectorName: '飞书', access: 'read' });
    expect(classifyConnectorTool('mcp__lark__calendar.v4.calendar.primary')?.access).toBe('read');
    expect(classifyConnectorTool(write)?.access).toBe('write');
    expect(classifyConnectorTool('mcp__unknown__read')).toBeNull();
    expect(classifyConnectorTool('mcp__notion__read')).toBeNull();
    expect(classifyConnectorTool('mcp__lark__')).toBeNull();
  });
  it('does not trust a server readOnlyHint or lookalike access/purpose in tool arguments', () => {
    const details = connectorApprovalDetails({ type: 'mcp', tool: write, details: { connectorAccess: forged, purpose: 'model purpose', readOnlyHint: true } as PermissionRequest['details'] });
    expect(details.connectorAccess?.access).toBe('write');
    expect(details.purpose).toBeUndefined();
  });
  it.each(['allow_run', 'allow_24h'] as const)('%s: read approval covers all six reads, never a write or another connector', async (tier) => {
    await approve(reads[0], tier);
    expect(listToolGrants()).toHaveLength(1);
    expect(listToolGrants()[0].tool).toBe('connector-read:lark');
    for (const read of reads) expect(preAsk(read)?.ledgerReason).toBe(`tool_grant:${tier === 'allow_run' ? 'run' : '24h'}`);
    expect(preAsk(write)).toBeNull();
    expect(preAsk('mcp__notion__calendar_v4_calendar_primary')).toBeNull();
    if (tier === 'allow_run') expect(preAsk(reads[1], 'different')).toBeNull();
  });
  it.each(['allow_run', 'allow_24h'] as const)('%s: write approval never covers reads and keeps the exact target', async (tier) => {
    await approve(write, tier, { details: { standingGrantTarget: 'calendar-weekly' } });
    expect(preAsk(write, 'weekly', 'calendar-weekly')).not.toBeNull();
    expect(preAsk(write, 'weekly', 'calendar-other')).toBeNull();
    for (const read of reads) expect(preAsk(read)).toBeNull();
  });
  it.each(['allow_run', 'allow_24h'] as const)('%s ignores renderer-supplied connectorAccess when minting', async (tier) => {
    const event = await approve(write, tier, { details: { connectorAccess: forged, purpose: 'injected' } });
    expect(event.details.connectorAccess?.access).toBe('write');
    expect(listToolGrants()[0].tool).toBe(write);
    expect(preAsk(reads[0])).toBeNull();
    await approve('mcp__unknown__read', tier, { details: { connectorAccess: forged } });
    expect(listToolGrants().every((grant) => grant.tool !== 'connector-read:lark')).toBe(true);
  });
  it('purpose uses automation title before chat title, omits unknown and never uses tool arguments', async () => {
    state.session = { title: '日程汇总', origin: { id: 'schedule-weekly' } };
    state.automation = { title: '每周日程汇总' };
    const scheduled = await approve(reads[0], 'allow', { type: 'network', details: { purpose: 'model supplied title' } });
    expect(scheduled.type).toBe('mcp');
    expect(scheduled.details.purpose).toBe('每周日程汇总');
    state.automation = null;
    expect((await approve(reads[0], 'allow')).details.purpose).toBe('日程汇总');
    state.session = null;
    expect((await approve(reads[0], 'allow', { details: { purpose: 'from args' } })).details.purpose).toBeUndefined();
  });
  it.each(['allow_run', 'allow_24h'] as const)('%s ledger read scope has stable id and revoke restores asking', async (tier) => {
    await approve(reads[0], tier);
    const row = listGrants().find((grant) => grant.connectorAccess === 'read');
    expect(row).toMatchObject({ label: '飞书', connectorAccess: 'read', source: tier === 'allow_run' ? 'run' : '24h' });
    expect(row?.id).toBe(listGrants().find((grant) => grant.connectorAccess === 'read')?.id);
    if (tier === 'allow_24h') expect(row?.expiresAt).toBeGreaterThan(Date.now());
    expect(revokeGrant(row!.id)).toBe(true);
    for (const read of reads) expect(preAsk(read)).toBeNull();
  });
});
