import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { listGrants, revokeGrant } from '../../../src/host/permissions/grantLedger';
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


  it('skips only the exact approved terminal input and asks again after revocation', async () => {
    const input = "echo '你好 🌿: " + 'x'.repeat(5000) + "'";
    expect((await terminal(input)).success).toBe(true);
    expect(cards[0].details).toMatchObject({ commandGrantTarget: input, preview: { summary: input } });
    const rows = listGrants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'terminal_write', detail: input, source: '24h' });

    expect((await terminal(input)).success).toBe(true);
    expect(cards).toHaveLength(1);
    response = 'allow';
    expect((await terminal(input + ' ')).success).toBe(true);
    expect(cards).toHaveLength(2);
    expect(revokeGrant(rows[0].id)).toBe(true);
    expect(listGrants()).toHaveLength(0);
    expect((await terminal(input)).success).toBe(true);
    expect(cards).toHaveLength(3);
    expect(pty.terminalWrite).toHaveBeenCalledTimes(4);
  });

  it('asks before changing the terminal, conversation, or Enter behavior of an approved input', async () => {
    const args = { input: 'echo hello', pressEnter: false };
    expect((await executor.execute('terminal_write', args, { sessionId })).success).toBe(true);
    expect((await executor.execute('terminal_write', args, { sessionId })).success).toBe(true);
    expect(cards).toHaveLength(1);

    response = 'allow';
    await executor.execute('terminal_write', args, { sessionId: 'another-conversation' });
    expect(cards).toHaveLength(2);
    await executor.execute('terminal_write', { ...args, session_id: 'another-terminal' }, { sessionId });
    expect(cards).toHaveLength(3);
    await executor.execute('terminal_write', { input: args.input }, { sessionId });
    expect(cards).toHaveLength(4);
  });

  it.each([
    { action: 'write', data: 'echo hello' },
    { action: 'submit', input: 'echo hello' },
  ])('scopes Process $action to action, session ID and payload', async (args) => {
    const original = { ...args, session_id: 'pty-one' };
    expect((await process(original)).success).toBe(true);
    expect(listToolGrants()).toMatchObject([{
      tool: 'Process', target: `${args.action}:"pty-one":echo hello`,
    }]);
    expect((await process(original)).success).toBe(true);
    expect(cards).toHaveLength(1);

    response = 'allow';
    for (const other of [
      { action: 'kill', session_id: 'pty-one' },
      { ...original, session_id: 'pty-two' },
      args.action === 'write'
        ? { action: 'submit', session_id: 'pty-one', input: 'echo hello' }
        : { action: 'write', session_id: 'pty-one', data: 'echo hello' },
      args.action === 'write' ? { ...original, data: 'echo bye' } : { ...original, input: 'echo bye' },
    ]) {
      expect((await process(other)).success).toBe(true);
    }
    expect(cards).toHaveLength(5);
    expect(pty.processKill).toHaveBeenCalledWith('pty-one');
  });

  it('lists legacy null-target rows for revocation but asks for both tools', async () => {
    mintTool24hGrant('terminal_write');
    mintTool24hGrant('Process');
    response = 'allow';
    expect((await terminal('echo hello')).success).toBe(true);
    expect((await process({ action: 'kill', session_id: 'pty-one' })).success).toBe(true);
    expect(cards).toHaveLength(2);
    const rows = listGrants();
    expect(rows.map((row) => row.detail)).toEqual([undefined, undefined]);
    for (const row of rows) expect(revokeGrant(row.id)).toBe(true);
    expect(listGrants()).toHaveLength(0);
  });

  it('treats a redacted Process payload as allow once, even with a spoofed target', async () => {
    const args = {
      action: 'submit', session_id: 'pty-one', input: 'echo password=fixture-value',
      commandGrantTarget: 'spoof',
    };
    const stderr = vi.spyOn(console, 'error');
    try {
      expect((await process(args)).success).toBe(true);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('WARN [HumanGrantPolicy] 24h command grant treated as allow once'),
        expect.objectContaining({ reason: 'command_redaction_or_invalid_text' }),
      );
    } finally {
      stderr.mockRestore();
    }
    expect(cards[0].details.commandGrantTarget).toBeNull();
    expect(listToolGrants()).toHaveLength(0);
    expect((await process(args)).success).toBe(true);
    expect(cards).toHaveLength(2);
  });
});
