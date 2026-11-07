import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, PermissionRequest, ToolDefinition } from '../../../src/shared/contract';
import { PermissionRequestReason } from '../../../src/shared/contract/permission';

const resolverState = vi.hoisted(() => ({
  definition: undefined as ToolDefinition | undefined,
  execute: vi.fn(),
}));

const activeTabState = vi.hoisted(() => ({
  url: null as string | null,
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: (name: string) => (resolverState.definition?.name === name ? resolverState.definition : undefined),
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/browserService', () => ({
  browserService: {
    getActiveTab: () => (activeTabState.url ? { id: 'tab-1', url: activeTabState.url, title: 'Test' } : null),
  },
}));

vi.mock('../../../src/host/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/platform')>();
  return {
    ...actual,
    broadcastToRenderer: vi.fn(),
  };
});

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: fake, createLogger: () => fake, default: fake };
});

import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getDecisionHistory, resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import {
  clearBrowserSessionGrants,
  listBrowserSessionGrants,
  matchBrowserSessionGrant,
  mintBrowserSessionGrant,
  resolveBrowserGrantScope,
} from '../../../src/host/permissions/browserSessionGrant';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

function makeHarness(defaultSessionId = 'session-1') {
  const askedRequests: PermissionRequest[] = [];
  const island = new OrchestratorPermissionIsland({
    getSettings: settings,
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'main',
    hasApprovalUi: () => true,
    onEvent: (event) => {
      if (event.type === 'permission_request') {
        const req = event.data as PermissionRequest;
        askedRequests.push(req);
        island.handlePermissionResponse(req.id, 'allow_session');
      }
    },
  });
  const executor = new ToolExecutor({
    requestPermission: (req) => island.requestPermission(req),
    workingDirectory: '/tmp/workspace',
  });
  return { executor, island, askedRequests, sessionId: defaultSessionId };
}

describe('browserSessionGrant', () => {
  beforeEach(() => {
    resetPermissionModeManager();
    resetDecisionHistory();
    clearBrowserSessionGrants();
    activeTabState.url = 'https://site-a.example.com/form';
    resolverState.definition = {
      name: 'Browser',
      description: 'browser tool',
      outputSchema: { type: 'string' },
      inputSchema: { type: 'object', properties: {} },
      requiresPermission: true,
      permissionLevel: 'execute',
    };
    resolverState.execute.mockReset().mockResolvedValue({ success: true, output: 'ok' });
  });

  it('② grant site A + handle_dialog: second handle_dialog on A is not asked (ledger reason browser_grant:...); same on B IS asked and the card reason names A and B', async () => {
    const { executor, askedRequests, sessionId } = makeHarness('session-2');
    await executor.execute('Browser', { action: 'handle_dialog', dialogAction: 'accept' }, { sessionId });
    expect(askedRequests).toHaveLength(1);
    expect(askedRequests[0].details.browserGrantScope).toEqual({
      action: 'handle_dialog',
      origin: 'https://site-a.example.com',
    });

    await executor.execute('Browser', { action: 'handle_dialog', dialogAction: 'accept' }, { sessionId });
    expect(askedRequests).toHaveLength(1);
    const [autoApproved] = getDecisionHistory().getRecent(1);
    expect(autoApproved).toMatchObject({
      outcome: 'auto-approve',
      reason: 'browser_grant:handle_dialog@https://site-a.example.com',
    });

    activeTabState.url = 'https://site-b.example.com/checkout';
    await executor.execute('Browser', { action: 'handle_dialog', dialogAction: 'accept' }, { sessionId });
    expect(askedRequests).toHaveLength(2);
    expect(askedRequests[1].reason).toContain('https://site-a.example.com');
    expect(askedRequests[1].reason).toContain('https://site-b.example.com');
  });

  it.each([
    { label: 'execute_goal', params: { action: 'execute_goal', goal: 'buy item' }, tabUrl: 'https://site-a.example.com/' },
    { label: 'upload_file', params: { action: 'upload_file', uploadFilePath: '/tmp/secret.pdf' }, tabUrl: 'https://site-a.example.com/' },
    { label: 'nav_back', params: { action: 'nav_back' }, tabUrl: 'https://site-a.example.com/' },
    { label: 'newTab', params: { action: 'newTab', url: 'https://site-a.example.com/' }, tabUrl: 'https://site-a.example.com/' },
    { label: 'unresolvable origin (no active tab)', params: { action: 'handle_dialog', dialogAction: 'accept' }, tabUrl: null },
    { label: 'unresolvable origin (about:blank)', params: { action: 'wait_for_download' }, tabUrl: 'about:blank' },
    { label: 'open with non-http url', params: { action: 'open', url: 'file:///tmp/x.html' }, tabUrl: 'https://site-a.example.com/' },
    {
      label: 'model-reported scope on ungrantable action',
      params: {
        action: 'execute_goal',
        goal: 'buy item',
        browserGrantScope: { action: 'handle_dialog', origin: 'https://site-a.example.com' },
      },
      tabUrl: 'https://site-a.example.com/',
    },
  ])('③ never granted ($label): allow_session then repeat still asks', async ({ params, tabUrl }) => {
    activeTabState.url = tabUrl;
    const { executor, askedRequests, sessionId } = makeHarness('session-3');

    await executor.execute('Browser', params, { sessionId });
    expect(askedRequests).toHaveLength(1);
    expect(askedRequests[0].details.browserGrantScope).toBeUndefined();
    expect(listBrowserSessionGrants(sessionId)).toHaveLength(0);

    await executor.execute('Browser', params, { sessionId });
    expect(askedRequests).toHaveLength(2);
  });

  it('ignores model-reported scope and stamps the host-resolved open origin', async () => {
    const { executor, askedRequests, sessionId } = makeHarness('session-host-scope');
    await executor.execute('Browser', {
      action: 'open',
      url: 'https://site-a.example.com/path',
      browserGrantScope: { action: 'open', origin: 'https://attacker.example.com' },
    }, { sessionId });

    expect(askedRequests[0].details.browserGrantScope).toEqual({
      action: 'open',
      origin: 'https://site-a.example.com',
    });
    expect(listBrowserSessionGrants(sessionId)).toMatchObject([{
      action: 'open',
      origin: 'https://site-a.example.com',
    }]);
  });

  it('④ grant is per session (session 2 asks), does not survive clearSession-style cleanup, and sensitive-step hand-back never mints', async () => {
    const { executor, island, askedRequests } = makeHarness('session-a');

    await executor.execute('Browser', { action: 'wait_for_download' }, { sessionId: 'session-a' });
    expect(askedRequests).toHaveLength(1);

    // Same session skips ask
    await executor.execute('Browser', { action: 'wait_for_download' }, { sessionId: 'session-a' });
    expect(askedRequests).toHaveLength(1);

    // Session 2 asks
    await executor.execute('Browser', { action: 'wait_for_download' }, { sessionId: 'session-b' });
    expect(askedRequests).toHaveLength(2);

    // clearBrowserSessionGrants (clearSession-style cleanup) clears session-a so it asks again
    clearBrowserSessionGrants('session-a');
    expect(listBrowserSessionGrants('session-a')).toHaveLength(0);
    await executor.execute('Browser', { action: 'wait_for_download' }, { sessionId: 'session-a' });
    expect(askedRequests).toHaveLength(3);

    // Sensitive-step hand-back never mints a browser grant
    clearBrowserSessionGrants();
    await island.requestPermission({
      type: 'command',
      tool: 'Browser',
      sessionId: 'session-sensitive',
      reasonCode: PermissionRequestReason.SensitiveStepHandback,
      details: {
        action: 'write_clipboard',
        browserGrantScope: { action: 'write_clipboard', origin: 'https://site-a.example.com' },
        sensitiveStep: { kind: 'password', appName: 'Browser' },
      },
    });
    expect(listBrowserSessionGrants('session-sensitive')).toHaveLength(0);
  });

  it.each([
    { action: 'handle_dialog', params: { action: 'handle_dialog', dialogAction: 'accept' }, tabUrl: 'https://site-a.example.com/page', expectedOrigin: 'https://site-a.example.com' },
    { action: 'read_clipboard', params: { action: 'read_clipboard' }, tabUrl: 'https://site-a.example.com:8443/path', expectedOrigin: 'https://site-a.example.com:8443' },
    { action: 'write_clipboard', params: { action: 'write_clipboard', clipboardText: 'hello' }, tabUrl: 'http://127.0.0.1:4321/a', expectedOrigin: 'http://127.0.0.1:4321' },
    { action: 'wait_for_download', params: { action: 'wait_for_download' }, tabUrl: 'http://localhost:4321/dl', expectedOrigin: 'http://localhost:4321' },
    { action: 'open', params: { action: 'open', url: 'https://open-target.example.org/welcome?x=1' }, tabUrl: 'https://site-a.example.com/ignored', expectedOrigin: 'https://open-target.example.org' },
  ])('⑥ consistency: key minted equals key matched for grantable action $action', ({ action, params, tabUrl, expectedOrigin }) => {
    activeTabState.url = tabUrl;
    const scope = resolveBrowserGrantScope('Browser', params);
    expect(scope).toEqual({ action, origin: expectedOrigin });

    mintBrowserSessionGrant('session-consistency', scope!, 1_700_000_000_000);
    const listed = listBrowserSessionGrants('session-consistency');
    expect(listed).toEqual([
      {
        sessionId: 'session-consistency',
        scopeKey: `${action}@${expectedOrigin}`,
        action,
        origin: expectedOrigin,
        grantedAt: 1_700_000_000_000,
      },
    ]);

    const matchedReason = matchBrowserSessionGrant('session-consistency', resolveBrowserGrantScope('browser_action', params));
    expect(matchedReason).toBe(`browser_grant:${listed[0].scopeKey}`);
  });
});
