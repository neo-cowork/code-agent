import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { BrowserService } from '../../../src/host/services/infra/browserService';
import * as browserAdapter from '../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import { SurfaceExecutionRuntime } from '../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../src/shared/contract/surfaceExecution';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { bindToolGrantDatabase, clearToolRunGrants } from '../../../src/host/permissions/toolGrantStore';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { resetDecisionHistory, getDecisionHistory } from '../../../src/host/security/decisionHistory';
import type { AppSettings, PermissionRequest } from '../../../src/shared/contract';

const dispatch = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({ getToolResolver: () => ({
  getDefinition: (name: string) => ({ name, requiresPermission: true, permissionLevel: 'execute', inputSchema: { type: 'object', properties: {} } }),
  execute: dispatch.execute,
}) }));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({ getSessionManager: () => ({ getSession: async () => undefined }) }));
vi.mock('../../../src/host/services/infra/notificationService', () => ({ notificationService: { notifyNeedsInput: vi.fn(), retractNeedsInput: vi.fn() } }));

function fakeBrowser() {
  let running = false;
  const urls = new Map([['active', 'about:blank'], ['other', 'https://other.example/reports']]);
  return {
    isRunning: () => running,
    ensureSession: async () => { running = true; },
    getActiveTab: () => running ? { id: 'active' } : null,
    getLiveTabUrl: (id = 'active') => {
      const url = urls.get(id);
      if (!url) throw new Error('Tab missing');
      return url;
    },
    navigate: async (url: string, id = 'active') => { urls.set(id, url); running = true; },
    getSessionState: () => ({ sessionId: 'fake-provider', profileId: 'fake-profile' }),
    getDomSnapshot: async () => ({ snapshotId: 'snapshot', tabId: 'active', capturedAtMs: Date.now(), url: urls.get('active'), title: 'Weekly reports', headings: [], interactiveElements: [] }),
    setLeaseInUse: () => {},
    close: async () => { running = false; },
  } as unknown as BrowserService;
}

describe('cross-turn permission resolution with the real managed adapter', () => {
  let db: Database.Database;
  let registry: RunRegistry;
  let adapter: browserAdapter.ManagedBrowserProviderAdapter;
  let executor: ToolExecutor;
  let requests: PermissionRequest[];
  let executedSites: string[];
  const sessionId = 'weekly-report-conversation';
  const identity = (runId: string, agentId = 'default') => ({ conversationId: sessionId, runId, agentId });
  const call = (runId: string, tabId?: string) => executor.execute('Browser', { action: 'wait_for_download', engine: 'managed', ...(tabId ? { tabId } : {}) }, { sessionId, runId, agentId: 'default' });
  const prepare = async (runId: string, url: string, agentId = 'default') => {
    registry.startAuxiliary({ runId, sessionId, workspace: '/tmp/reports' });
    const owner = identity(runId, agentId);
    // Production browserAction selects its run-keyed service before adapter.execute.
    await adapter.getBrowserService(owner).navigate(url);
    const result = await adapter.execute({ identity: owner, operationId: `prepare-${runId}`, action: 'get_content', params: {},
      executeProvider: async () => ({ success: true, output: 'Weekly reports' }) });
    expect(result.success).toBe(true);
  };
  beforeEach(() => {
    resetPermissionModeManager(); resetDecisionHistory(); bindToolGrantDatabase(null, true);
    db = new Database(':memory:');
    db.exec(`CREATE TABLE pending_approvals (id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT, payload_json TEXT, status TEXT DEFAULT 'pending', submitted_at INTEGER, resolved_at INTEGER, feedback TEXT)`);
    registry = new RunRegistry();
    const services = new Map<string | null, BrowserService>();
    adapter = new browserAdapter.ManagedBrowserProviderAdapter(new SurfaceExecutionRuntime({ runRegistry: registry }), (key) => {
      if (!services.has(key)) services.set(key, fakeBrowser());
      return services.get(key)!;
    }, async () => {}, {
      exportForConversation: async () => '/tmp/resume', importForConversation: async () => false,
      clearConversation: async () => {}, activateConversation: () => {},
    });
    vi.spyOn(browserAdapter, 'getManagedBrowserProviderAdapter').mockReturnValue(adapter);
    requests = []; executedSites = [];
    const island = new OrchestratorPermissionIsland({
      injectedPendingApprovalRepo: new PendingApprovalRepository(db),
      getSettings: () => ({ permissions: { autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [], devModeAutoApprove: false } }) as unknown as AppSettings,
      isDevModeAutoApproveEnabled: () => false, getExecutionTopology: () => 'main', hasApprovalUi: () => true,
      onEvent: (event) => {
        if (event.type !== 'permission_request') return;
        const request = event.data as PermissionRequest; requests.push(request);
        island.handlePermissionResponse(request.id, 'allow_run');
      },
    });
    executor = new ToolExecutor({ workingDirectory: '/tmp/reports', requestPermission: (r) => island.requestPermission(r) });
    dispatch.execute.mockImplementation(async (_name, params, context) => {
      const owner = browserAdapter.surfaceIdentityFromToolContext(context)!;
      executedSites.push(adapter.getBrowserService(owner).getLiveTabUrl(params.tabId));
      return { success: true, output: 'Report downloaded' };
    });
  });
  afterEach(() => { vi.restoreAllMocks(); bindToolGrantDatabase(null, true); db.close(); });

  it.each(['finished', 'stopped'])('a %s prior turn cannot authorize another browser service through a shared user binding', async (ending) => {
    await prepare('y1', 'http://localhost:8123/reports');
    await call('y1');
    expect(requests).toHaveLength(1);
    // A real user browser owner is the condition that makes ensureBinding share.
    await prepare('user-rail', 'http://localhost:8123/reports', SURFACE_USER_BROWSER_AGENT_ID);
    if (ending === 'stopped') await registry.get('y1')!.cancel('user');
    registry.unregister('y1');
    clearToolRunGrants(sessionId);
    await prepare('y2', 'http://127.0.0.1:8123/reports');
    expect(adapter.getBinding(identity('y2'))!.browserService.getLiveTabUrl()).toBe('http://localhost:8123/reports');
    await call('y2');
    expect(executedSites.at(-1)).toBe('http://127.0.0.1:8123/reports');
    expect(requests, 'a new origin must ask even when the binding still describes the old user window').toHaveLength(2);
    expect(requests[1].details.browserSessionGrant).toEqual({ target: 'wait_for_download@http://127.0.0.1:8123', previousOrigins: ['http://localhost:8123'] });
    await prepare('y3', 'http://localhost:8123/reports');
    await call('y3');
    expect(requests).toHaveLength(2);
    expect(getDecisionHistory().getRecent(20).at(-1)?.reason).toBe('tool_grant:session');
  });

  it('resolves an explicit non-active tab and fails closed for missing tabs or bindings', async () => {
    await prepare('y1', 'http://localhost:8123/reports');
    await call('y1', 'other');
    expect(requests[0].details.browserSessionGrant?.target).toBe('wait_for_download@https://other.example');
    await call('y1', 'missing'); await call('y1', 'missing');
    expect(requests).toHaveLength(3);
    expect(requests[2].details.browserSessionGrant?.target).toBeNull();
    await call('no-binding'); await call('no-binding');
    expect(requests).toHaveLength(5);
    expect(requests[4].details.browserSessionGrant?.target).toBeNull();
  });
});
