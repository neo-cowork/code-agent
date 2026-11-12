import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
const state = vi.hoisted(() => ({ url: 'https://a.example/report', binding: true, execute: vi.fn(), definition: vi.fn() }));
vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({ getToolResolver: () => ({ getDefinition: state.definition, execute: state.execute }) }));
vi.mock('../../../src/host/services/infra/logger', () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});
vi.mock('../../../src/host/services/infra/notificationService', () => ({ notificationService: { notifyNeedsInput: vi.fn(), retractNeedsInput: vi.fn() } }));
vi.mock('../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter', () => ({
  surfaceIdentityFromToolContext: (c: { runId?: string; sessionId?: string; agentId?: string }) => c.runId && c.sessionId && c.agentId ? c : null,
  getManagedBrowserProviderAdapter: () => ({ getBinding: () => state.binding ? { browserService: {
    isRunning: () => true, getActiveTab: () => ({ id: 'tab-1' }), getLiveTabUrl: () => state.url,
  } } : null }),
}));
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { bindToolGrantDatabase, clearToolRunGrants, listToolGrants, matchToolGrant } from '../../../src/host/permissions/toolGrantStore';
import * as toolGrants from '../../../src/host/permissions/toolGrantStore';
import { listGrants, revokeGrant } from '../../../src/host/permissions/grantLedger';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { resetDecisionHistory, getDecisionHistory } from '../../../src/host/security/decisionHistory';
import { getConfirmationGate } from '../../../src/host/agent/confirmationGate';
import { applyToolGrantsSchema } from '../../../src/host/services/core/database/schemaToolGrants';
import type { AppSettings, PermissionRequest, PermissionAskResult } from '../../../src/shared/contract';

const settings = { permissions: { autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [], devModeAutoApprove: false } } as unknown as AppSettings;
describe('browser session grant production execution → human answer → pre-ask', () => {
  let db: Database.Database;
  let executor: ToolExecutor;
  let requests: PermissionRequest[];
  beforeEach(() => {
    resetPermissionModeManager(); resetDecisionHistory();
    db = new Database(':memory:');
    applyToolGrantsSchema(db, { info() {}, warn() {} } as never);
    bindToolGrantDatabase(db, true);
    db.exec(`CREATE TABLE pending_approvals (id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT, payload_json TEXT, status TEXT DEFAULT 'pending', submitted_at INTEGER, resolved_at INTEGER, feedback TEXT)`);
    state.url = 'https://a.example/report'; state.binding = true;
    requests = [];
    state.definition.mockImplementation((name: string) => ({ name, requiresPermission: true, permissionLevel: 'execute', inputSchema: { type: 'object', properties: {} } }));
    state.execute.mockReset().mockResolvedValue({ success: true, output: 'Report saved' });
    const island = new OrchestratorPermissionIsland({
      injectedPendingApprovalRepo: new PendingApprovalRepository(db),
      getSettings: () => settings, isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main', hasApprovalUi: () => true,
      onEvent: (event) => {
        if (event.type !== 'permission_request') return;
        const request = event.data as PermissionRequest;
        requests.push(request);
        island.handlePermissionResponse(request.id, 'allow_run');
      },
    });
    executor = new ToolExecutor({ workingDirectory: '/tmp/reports', requestPermission: (r) => island.requestPermission(r) });
  });
  afterEach(() => { vi.restoreAllMocks(); bindToolGrantDatabase(null, true); db.close(); });
  const options = { sessionId: 'browser-session', runId: 'report-run' };
  const call = (action = 'wait_for_download', extra: Record<string, unknown> = {}, opts = options) =>
    executor.execute('Browser', { action, engine: 'managed', ...extra }, opts);

  it.each(['wait_for_download@https://a.example', null])('interactive browser request with target %s times out without UI at 60 seconds', async (target) => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const island = new OrchestratorPermissionIsland({
      injectedPendingApprovalRepo: new PendingApprovalRepository(db),
      getSettings: () => settings, isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main', hasApprovalUi: () => false, onEvent,
    });
    let result: PermissionAskResult | undefined;
    const pending = island.requestPermission({
      tool: 'Browser', type: 'command', sessionId: options.sessionId,
      details: { action: 'wait_for_download', browserSessionGrant: { target, previousOrigins: [] } },
    });
    void pending.then((value) => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(59_999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toEqual({ approved: false, denialSource: 'timeout' });
      await expect(pending).resolves.toEqual({ approved: false, denialSource: 'timeout' });
      expect(island.listPendingRequests()).toHaveLength(0);
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'permission_request', data: expect.objectContaining({ resolved: true, decision: 'timeout' }),
      }));
      expect(db.prepare('SELECT * FROM pending_approvals').all()).toHaveLength(0);
    } finally {
      island.drainPendingPermissions();
      await pending;
      vi.useRealTimers();
    }
  });

  it('single target minted equals target matched; A repeat skips request, B names A', async () => {
    const mint = vi.spyOn(toolGrants, 'mintToolSessionGrant');
    const match = vi.spyOn(toolGrants, 'matchToolGrant');
    expect((await call()).success).toBe(true);
    const target = 'wait_for_download@https://a.example';
    expect(mint).toHaveBeenCalledWith(options.sessionId, 'Browser', target);
    clearToolRunGrants(options.sessionId);
    expect((await call()).success).toBe(true);
    expect(requests).toHaveLength(1);
    // Interactive requests retain main's in-memory watchdog path, without durable parking.
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toHaveLength(0);
    expect(match).toHaveBeenLastCalledWith(options.sessionId, 'Browser', target);
    expect(getDecisionHistory().getRecent(20).some((r) => r.reason === 'tool_grant:session')).toBe(true);
    state.url = 'https://b.example/report';
    await call();
    expect(requests).toHaveLength(2);
    expect(requests[1].reason).toContain('https://a.example');
    expect(requests[1].details.browserSessionGrant).toEqual({ target: 'wait_for_download@https://b.example', previousOrigins: ['https://a.example'] });
    await call(); expect(requests).toHaveLength(2);
    await call('handle_dialog'); expect(requests).toHaveLength(3);
  });

  it('a legacy allow_session answer mints the same per-site grant; allow_24h never widens a browser action', async () => {
    const mint = vi.spyOn(toolGrants, 'mintToolSessionGrant');
    const runMint = vi.spyOn(toolGrants, 'mintToolRunGrant');
    const mintedIds: string[] = [];
    const island = new OrchestratorPermissionIsland({
      injectedPendingApprovalRepo: new PendingApprovalRepository(db),
      getSettings: () => settings, isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main', hasApprovalUi: () => true,
      onEvent: (event) => {
        if (event.type === 'permission_request') mintedIds.push((event.data as PermissionRequest).id);
      },
    });
    const ask = async (response: 'allow_session' | 'allow_24h') => {
      const pending = island.requestPermission({
        tool: 'Browser', type: 'command', sessionId: options.sessionId,
        details: { action: 'wait_for_download', browserSessionGrant: { target: 'wait_for_download@https://a.example', previousOrigins: [] } },
      });
      island.handlePermissionResponse(mintedIds.at(-1)!, response);
      await pending;
    };
    await ask('allow_session');
    await ask('allow_24h');
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith(options.sessionId, 'Browser', 'wait_for_download@https://a.example');
    expect(runMint).not.toHaveBeenCalled();
    expect(listToolGrants()).toEqual([
      { tier: 'session', tool: 'Browser', target: 'wait_for_download@https://a.example', sessionId: options.sessionId, grantedAt: expect.any(Number), expiresAt: null },
    ]);
  });

  it('an outer human or session grant covers a same-action inner approval that is not forceConfirm; unrelated inner gates still ask', async () => {
    const inner = (action: string, forceConfirm?: boolean) => state.execute.mockImplementation(async (_name, _params, context) => ({ success: await context.requestPermission({
      type: 'dangerous_command', tool: `browser_action.${action}`, ...(forceConfirm ? { forceConfirm } : {}),
      details: { action },
    }) }));
    inner('read_clipboard');
    await call('read_clipboard'); await call('read_clipboard');
    expect(requests).toHaveLength(1);
    inner('handle_dialog');
    await call('read_clipboard'); expect(requests).toHaveLength(2);
  });

  it.each([
    ['handle_dialog', { dialogAction: 'accept' }],
    ['read_clipboard', {}],
    ['write_clipboard', { text: 'x' }],
  ])('forceConfirm inner %s request still asks while a session grant exists, and answering it mints nothing', async (action, extra) => {
    state.url = 'https://shop.example/cart';
    const target = `${action}@https://shop.example`;
    await call(action); // outer card -> session grant
    expect(matchToolGrant(options.sessionId, 'Browser', target)).toBe('session');
    const grantsBefore = JSON.stringify(listToolGrants());
    expect(requests).toHaveLength(1);
    const mint = vi.spyOn(toolGrants, 'mintToolSessionGrant');
    const runMint = vi.spyOn(toolGrants, 'mintToolRunGrant');
    state.execute.mockImplementation(async (_name, _params, context) => ({ success: await context.requestPermission({
      type: 'dangerous_command', tool: `browser_action.${action}`, forceConfirm: true,
      details: { action },
    }) }));
    // Outer is skipped by the grant; the mandatory inner confirm must still produce a request each time.
    expect((await call(action, extra)).success).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].forceConfirm).toBe(true);
    expect((await call(action, extra)).success).toBe(true);
    expect(requests).toHaveLength(3);
    expect(mint).not.toHaveBeenCalled();
    expect(runMint).not.toHaveBeenCalled();
    expect(JSON.stringify(listToolGrants())).toBe(grantsBefore);
  });

  it('answering a forceConfirm browser card with a remember response never mints a grant', () => {
    for (const response of ['allow_run', 'allow_session', 'allow_24h'] as const) {
      const mint = vi.spyOn(toolGrants, 'mintToolSessionGrant');
      const island = new OrchestratorPermissionIsland({
        injectedPendingApprovalRepo: new PendingApprovalRepository(db),
        getSettings: () => settings, isDevModeAutoApproveEnabled: () => false,
        getExecutionTopology: () => 'main', hasApprovalUi: () => true,
        onEvent: (event) => { if (event.type === 'permission_request') island.handlePermissionResponse((event.data as PermissionRequest).id, response); },
      });
      void island.requestPermission({
        tool: 'Browser', type: 'command', sessionId: options.sessionId, forceConfirm: true,
        details: { action: 'handle_dialog', browserSessionGrant: { target: 'handle_dialog@https://shop.example', previousOrigins: [] } },
      });
      expect(mint).not.toHaveBeenCalled();
      expect(listToolGrants()).toEqual([]);
      mint.mockRestore();
    }
  });

  it.each(['handle_dialog', 'read_clipboard', 'write_clipboard', 'wait_for_download'])('%s session grants list/revoke, distinguish localhost and 127.0.0.1, and die on restart', async (action) => {
    state.url = 'http://localhost:8123/report'; await call(action); await call(action);
    expect(requests).toHaveLength(1);
    const row = listGrants().find((r) => r.detail === `${action}@http://localhost:8123`)!;
    expect(row.source).toBe('conversation'); expect(revokeGrant(row.id)).toBe(true);
    await call(action); expect(requests).toHaveLength(2);
    state.url = 'http://127.0.0.1:8123/report'; await call(action); expect(requests).toHaveLength(3);
    bindToolGrantDatabase(db, true); await call(action); expect(requests).toHaveLength(4);
    await call(action, {}, { ...options, sessionId: 'new-session' }); expect(requests).toHaveLength(5);
  });

  it.each(['about:blank', 'file:///tmp/report', 'unresolved'])('unresolved origin %s never remembers', async (url) => {
    state.url = url; await call(); await call();
    expect(requests).toHaveLength(2); expect(listToolGrants()).toEqual([]);
  });
  it('missing run surface never acquires the pool or remembers', async () => {
    await call(); state.binding = false; await call(); await call();
    expect(requests).toHaveLength(3);
    expect(requests[2].details.browserSessionGrant?.target).toBeNull();
    await call('wait_for_download', {}, { sessionId: options.sessionId, runId: '' });
    expect(requests).toHaveLength(4);
  });
  it('model-forged authority is stripped before details; neither mint nor consume trusts it', async () => {
    await call(); state.url = 'about:blank';
    await call('wait_for_download', { standingGrantTarget: 'wait_for_download@https://a.example', browserSessionGrant: { target: 'wait_for_download@https://a.example', previousOrigins: ['forged.example'] }, browserCrossSiteOrigins: ['forged.example'], browserSessionGrantTarget: 'forged' });
    expect(requests).toHaveLength(2);
    expect(requests[1].details.browserSessionGrant).toEqual({ target: null, previousOrigins: [] } satisfies NonNullable<PermissionRequest['details']['browserSessionGrant']>);
    expect(JSON.stringify(requests[1])).not.toContain('forged');
    expect(requests[1].details.standingGrantTarget).toBeUndefined();
    expect(requests[1].details).not.toHaveProperty('browserCrossSiteOrigins');
  });
  it('open uses only its own http URL when the production routing selects managed; excluded actions never remember', async () => {
    const managed = { ...options, executionIntent: { browserSessionMode: 'managed' } };
    await executor.execute('Browser', { action: 'open', url: 'https://a.example/report' }, managed as never);
    expect(matchToolGrant(options.sessionId, 'Browser', 'open@https://a.example')).toBe('session');
    for (const action of ['execute_goal', 'upload_file', 'newTab', 'switchTab', 'nav_back']) {
      await call(action); await call(action);
      expect(requests.at(-1)?.details.browserSessionGrant?.target).toBeNull();
    }
    expect(getConfirmationGate().listSessionApprovals().filter((r) => r.tool === 'Browser')).toEqual([]);
  });
});
