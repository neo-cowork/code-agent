import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, PermissionRequest, ToolDefinition } from '../../../src/shared/contract';

const resolverState = vi.hoisted(() => ({
  definition: undefined as ToolDefinition | undefined,
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: (name: string) => (resolverState.definition?.name === name ? resolverState.definition : undefined),
    execute: resolverState.execute,
  }),
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
import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { clearBrowserSessionGrants } from '../../../src/host/permissions/browserSessionGrant';
import {
  forgetBrowserGrantSurfacesForConversation,
  forgetLegacyBrowserGrantSource,
  rememberBrowserGrantSurface,
  rememberLegacyBrowserGrantSource,
} from '../../../src/host/services/infra/browserGrantActiveUrlRegistry';

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

describe('browserSessionGrant legacy-pool fallback (real registry)', () => {
  const sessionId = 'legacy-session';
  const agentId = 'legacy-agent';
  const siteA = { getActiveTab: () => ({ url: 'https://site-a.example.com/form' }) };

  beforeEach(() => {
    resetPermissionModeManager();
    resetDecisionHistory();
    clearBrowserSessionGrants();
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

  it('new run without a registered managed surface is not auto-approved from the legacy pool browser', async () => {
    const { executor, askedRequests } = makeHarness();
    rememberBrowserGrantSurface({ conversationId: sessionId, runId: 'run-1', agentId }, siteA);
    await executor.execute('Browser', { action: 'read_clipboard' }, { sessionId, runId: 'run-1', agentId } as never);
    expect(askedRequests).toHaveLength(1);
    expect(askedRequests[0].details.browserGrantScope).toEqual({
      action: 'read_clipboard',
      origin: 'https://site-a.example.com',
    });

    // Legacy pool browser for the same agent still shows site A; run-2 has no managed surface yet.
    rememberLegacyBrowserGrantSource(agentId, siteA);
    try {
      await executor.execute('Browser', { action: 'read_clipboard' }, { sessionId, runId: 'run-2', agentId } as never);
    } finally {
      forgetLegacyBrowserGrantSource(agentId);
      forgetBrowserGrantSurfacesForConversation(sessionId);
    }
    expect(askedRequests).toHaveLength(2);
    expect(askedRequests[1].details.browserGrantScope).toBeUndefined();
  });
});
