import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { bindToolGrantDatabase, listToolGrants, mintTool24hGrant } from '../../../src/host/permissions/toolGrantStore';
import { applyToolGrantsSchema } from '../../../src/host/services/core/database/schemaToolGrants';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequest, PermissionResponse } from '../../../src/shared/contract';

const pty = vi.hoisted(() => ({
  terminalWrite: vi.fn(() => ({ ok: true })),
  processWrite: vi.fn(() => ({ success: true })),
  processSubmit: vi.fn(() => ({ success: true })),
  processKill: vi.fn(() => ({ success: true })),
}));

vi.mock('../../../src/host/services/terminal/terminalSessionManager', () => ({
  getTerminalSnapshot: () => ({ alive: true, data: '' }),
  isTerminalOnAlternateScreen: () => false,
  annotateTerminalSession: vi.fn(),
  writeToTerminalSession: pty.terminalWrite,
}));

vi.mock('../../../src/host/tools/shell/ptyExecutor', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/tools/shell/ptyExecutor')>(),
  isPtySessionId: (id: string) => id.startsWith('pty-'),
  writeToPtySession: pty.processWrite,
  submitToPtySession: pty.processSubmit,
  killPtySession: pty.processKill,
}));

const sessionId = 'command-grant-chat';
const settings = () => ({
  permissions: { autoApprove: { read: false, write: false, execute: false, network: false } },
});

describe('24h command grants through ToolExecutor', () => {
  let db: Database.Database;
  let executor: ToolExecutor;
  let response: PermissionResponse;
  let cards: PermissionRequest[];

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    applyToolGrantsSchema(db, { info: vi.fn() } as unknown as Parameters<typeof applyToolGrantsSchema>[1]);
    bindToolGrantDatabase(db, true);
    response = 'allow_24h';
    cards = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: settings as never,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => true,
      onEvent: (event) => {
        if (event.type !== 'permission_request' || event.data.resolved) return;
        cards.push(event.data);
        island.handlePermissionResponse(event.data.id, response);
      },
    });
    executor = new ToolExecutor({
      workingDirectory: '/tmp',
      requestPermission: (request) => island.requestPermission(request),
    });
    executor.setAuditEnabled(false);
  });

  afterEach(() => {
    bindToolGrantDatabase(null, true);
    db.close();
  });

  const terminal = (input: string) => executor.execute('terminal_write', { input }, { sessionId });
  const process = (args: Record<string, unknown>) => executor.execute('Process', args, { sessionId });

  it('asks inside terminal_write despite a minted unscoped grant', async () => {
    expect((await terminal('echo hello')).success).toBe(true);
    expect(listToolGrants()).toMatchObject([{ tool: 'terminal_write', target: null }]);
    expect((await terminal('echo hello')).success).toBe(true);
    expect(cards).toHaveLength(2);
    expect(cards[1].details.grantEligible).toBe(false);
    expect(pty.terminalWrite).toHaveBeenCalledTimes(2);
  });

  it('uses a minted unscoped Process grant for a subsequent kill', async () => {
    mintTool24hGrant('Process');
    response = 'deny';
    await process({ action: 'kill', session_id: 'pty-one' });
    expect(cards).toHaveLength(0);
    expect(pty.processKill).toHaveBeenCalledWith('pty-one');
  });
});
