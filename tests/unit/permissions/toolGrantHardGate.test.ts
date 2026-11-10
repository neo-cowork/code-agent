import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

const databaseState = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
}));

const classifierState = vi.hoisted(() => ({
  withoutTrustBoundary: false,
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => databaseState.db,
  }),
}));

vi.mock('../../../src/host/tools/toolPermissionClassification', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/host/tools/toolPermissionClassification')
  >();
  return {
    ...actual,
    resolveToolPermissionClassification: async (
      input: Parameters<typeof actual.resolveToolPermissionClassification>[0],
    ) => {
      const result = await actual.resolveToolPermissionClassification(input);
      const traceRule = result.traceStep?.rule;
      if (
        classifierState.withoutTrustBoundary
        && (traceRule === 'B1: sensitive_credential_read'
          || traceRule === 'B1: git_remote_or_credential_write')
      ) {
        // Keep the real deterministic B1 classification while isolating its own
        // grant hard gate from the classifier's separate trust-boundary marker.
        return { ...result, trustBoundary: false };
      }
      return result;
    },
  };
});

vi.mock('../../../src/host/services/infra/logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => logger), logger, default: logger };
});

import { applyToolGrantsSchema } from '../../../src/host/services/core/database/schemaToolGrants';
import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getPermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { ToolExecutor, type ToolExecutorConfig } from '../../../src/host/tools/toolExecutor';
import { createRunContext } from '../../../src/host/runtime/runContext';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import { resetConfirmationGate } from '../../../src/host/agent/confirmationGate';
import {
  bindToolGrantDatabase,
  clearToolRunGrants,
  mintTool24hGrant,
  mintToolRunGrant,
  revokeTool24hGrant,
} from '../../../src/host/permissions/toolGrantStore';

const logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as unknown as Parameters<typeof applyToolGrantsSchema>[1];

const BASH_DEFINITION = {
  name: 'Bash',
  description: 'shell test tool',
  inputSchema: { type: 'object', properties: {}, required: ['command'] },
  requiresPermission: true,
  permissionLevel: 'execute',
};

const WRITE_DEFINITION = {
  name: 'Write',
  description: 'write test tool',
  inputSchema: { type: 'object', properties: {}, required: ['file_path', 'content'] },
  requiresPermission: true,
  permissionLevel: 'write',
};

type GrantTier = 'run' | '24h';

describe('ToolExecutor grant hard gates', () => {
  let db: Database.Database;
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    databaseState.db = db;
    applyToolGrantsSchema(db, logger);
    bindToolGrantDatabase(db, true);

    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grant-hardgate-')));
    outside = path.join('/var/tmp', `${path.basename(workspace)}-outside`);
    await fs.mkdir(outside);

    resolverState.getDefinition.mockReset();
    resolverState.getDefinition.mockImplementation((toolName: string) => {
      if (toolName === 'Bash') return BASH_DEFINITION;
      if (toolName === 'Write') return WRITE_DEFINITION;
      return undefined;
    });
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
    getToolCache().clear();
    getPermissionClassifier().clearCache();
    resetConfirmationGate();
    classifierState.withoutTrustBoundary = false;
  });

  afterEach(async () => {
    resetConfirmationGate();
    clearToolRunGrants('hardgate-session');
    bindToolGrantDatabase(null, true);
    databaseState.db = null;
    db.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  function buildExecutor(
    requestPermission: ToolExecutorConfig['requestPermission'],
    options: { forcePermissionHandler?: boolean; runContext?: ReturnType<typeof createRunContext> } = {},
  ): ToolExecutor {
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: workspace,
      ...(options.forcePermissionHandler ? { forcePermissionHandler: true } : {}),
      ...(options.runContext ? { runContext: options.runContext } : {}),
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  function boundaryRunContext(sessionId: string) {
    return createRunContext({
      runId: `hardgate-run-${sessionId}`,
      sessionId,
      workspace,
      cwd: workspace,
      workspaceScope: createWorkspaceScope('hardgate-project', [{
        sourceId: 'hardgate-primary',
        path: workspace,
        role: 'primary',
        access: 'read_write',
      }]),
    });
  }

  async function executeWithGrant(
    tier: GrantTier,
    toolName: 'Bash' | 'Write',
    params: Record<string, unknown>,
    sessionId: string,
    options: { forcePermissionHandler?: boolean; runContext?: ReturnType<typeof createRunContext> } = {},
  ) {
    clearToolRunGrants(sessionId);
    revokeTool24hGrant(toolName, null);
    if (tier === 'run') mintToolRunGrant(sessionId, toolName, null);
    else mintTool24hGrant(toolName, null);

    const requestPermission = vi.fn(async () => true);
    const result = await buildExecutor(requestPermission, options).execute(toolName, params, { sessionId });
    return { requestPermission, result };
  }

  async function expectCardForBothGrantTiers(
    toolName: 'Bash' | 'Write',
    params: Record<string, unknown>,
    sessionId: string,
    options: { forcePermissionHandler?: boolean; runContext?: ReturnType<typeof createRunContext> } = {},
  ) {
    for (const tier of ['run', '24h'] as const) {
      const { requestPermission, result } = await executeWithGrant(
        tier,
        toolName,
        params,
        sessionId,
        options,
      );
      expect(result.success, `${tier} grant should still execute after approval`).toBe(true);
      expect(requestPermission, `${tier} grant must not bypass the approval card`).toHaveBeenCalledOnce();
    }
  }

  it('credential reads remain gated after run and 24h Bash grants', async () => {
    classifierState.withoutTrustBoundary = true;
    await expectCardForBothGrantTiers(
      'Bash',
      { command: 'cat ~/.ssh/id_rsa' },
      'hardgate-session',
    );
  });

  it('git remote changes remain gated after run and 24h Bash grants', async () => {
    classifierState.withoutTrustBoundary = true;
    await expectCardForBothGrantTiers(
      'Bash',
      { command: 'git remote set-url origin https://example.invalid/repo.git' },
      'hardgate-session',
    );
  });

  it('W3 write-boundary asks remain gated after run and 24h Write grants', async () => {
    await expectCardForBothGrantTiers(
      'Write',
      { file_path: path.join(outside, 'boundary.txt'), content: 'hard gate' },
      'hardgate-session',
      { runContext: boundaryRunContext('hardgate-session') },
    );
  });

  it('real high-risk confirmation gate remains gated after run and 24h Bash grants', async () => {
    for (const tier of ['run', '24h'] as const) {
      const { requestPermission, result } = await executeWithGrant(
        tier,
        'Bash',
        { command: 'npm publish' },
        'hardgate-session',
      );
      expect(result.success, `${tier} high-risk command should execute after approval`).toBe(true);
      expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
        forceConfirm: true,
        dangerLevel: 'danger',
      }));
    }
  });

  it('forcePermissionHandler remains gated after run and 24h Bash grants', async () => {
    await expectCardForBothGrantTiers(
      'Bash',
      { command: 'echo hardgate-force-handler' },
      'hardgate-session',
      { forcePermissionHandler: true },
    );
  });

  it('ordinary Bash asks still consume a grant without showing a card', async () => {
    for (const tier of ['run', '24h'] as const) {
      const { requestPermission, result } = await executeWithGrant(
        tier,
        'Bash',
        { command: 'npm install left-pad' },
        'hardgate-session',
      );
      expect(result.success, `${tier} ordinary ask should execute via grant`).toBe(true);
      expect(requestPermission, `${tier} ordinary ask should consume the grant`).not.toHaveBeenCalled();
    }
  });
});
