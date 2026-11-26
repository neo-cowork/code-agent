// ============================================================================
// 重启后点「24 小时内允许」必须真铸 24h 授权（N-PERM-GRANT-TIERS-P2-HOST-RESUME-GRANT）
// 真实 SQLite（pending_approvals + tool_permission_grants）+ 真 toolGrantStore，
// 一律走生产入口 resumeSurvivingParkedApproval。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const real = actual.createLogger(name);
      real.warn = warn;
      return real;
    },
  };
});

import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { resumeSurvivingParkedApproval } from '../../../src/host/agent/parkedApprovalResume';
import { computeLedgerArgsSurvival } from '../../../src/host/agent/parkedApprovalSurvival';
import {
  bindToolGrantDatabase,
  listToolGrants,
  matchToolGrant,
} from '../../../src/host/permissions/toolGrantStore';
import { TOOL_GRANT_TIERS } from '../../../src/shared/constants';
import type { Message } from '../../../src/shared/contract';
import type { PermissionResponse } from '../../../src/shared/contract/permission';
import type { ToolApprovalPayload } from '../../../src/shared/contract/pendingApproval';

describe('restart resume mints the tier grant', () => {
  let db: BetterSqlite3.Database;
  let repo: PendingApprovalRepository;
  let executions: number;
  let messages: Message[];
  const sessionId = 'grant-session';
  const toolCallId = 'call-grant';
  const now = 5_000_000;

  function setLedger(tool: string, args: Record<string, unknown>): void {
    messages = [
      { id: 'u', role: 'user', content: 'go', timestamp: 1 },
      { id: 'a', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: toolCallId, name: tool, arguments: args }] },
    ] as Message[];
  }

  function seed(input: {
    tool?: string;
    args?: Record<string, unknown>;
    payload?: Partial<ToolApprovalPayload>;
    fingerprintArgs?: Record<string, unknown>;
    requestedAt?: number;
  } = {}): void {
    const tool = input.tool ?? 'Bash';
    const args = input.args ?? { command: 'sleep 30' };
    setLedger(tool, args);
    repo.insert({
      id: 'g-1',
      kind: 'tool_approval',
      agentId: null,
      agentName: null,
      coordinatorId: sessionId,
      payload: {
        sessionId,
        toolCallId,
        tool,
        type: 'command',
        permissionLevel: 'medium',
        requestedAt: input.requestedAt ?? now - 1_000,
        argsRef: { sessionId, toolCallId },
        argsFingerprint: computeLedgerArgsSurvival(tool, input.fingerprintArgs ?? args).argsFingerprint,
        ledgerFaithful: true,
        ...input.payload,
      },
      submittedAt: now - 1_000,
    });
  }

  const ports = () => ({
    repo,
    loadMessages: () => messages,
    resolveWorkingDirectory: () => '/tmp',
    async executeTool() {
      executions += 1;
      return { success: true, output: 'ok', metadata: {} };
    },
    async persistToolMessage(_s: string, message: Message) { messages = [...messages, message]; },
    now: () => now,
  });
  const resume = (response: PermissionResponse) =>
    resumeSurvivingParkedApproval({ requestId: 'g-1', response, now, ports: ports() });
  const warnTexts = () => warn.mock.calls.map((call) => String(call[0]));

  beforeEach(() => {
    warn.mockClear();
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
        payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT
      );
      CREATE TABLE tool_permission_grants (
        tool_key TEXT PRIMARY KEY, tool_name TEXT NOT NULL, target TEXT,
        granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    repo = new PendingApprovalRepository(db);
    bindToolGrantDatabase(db, true);
    executions = 0;
  });
  afterEach(() => {
    bindToolGrantDatabase(null, true);
    db.close();
  });

  it('allow_24h: executes once, mints 24h grant (expiresAt = now + 24h), matches, and lapses after expiry', async () => {
    seed();
    const outcome = await resume('allow_24h');
    expect(outcome).toMatchObject({ handled: true, status: 'executed' });
    expect(executions).toBe(1);
    const row = db.prepare('SELECT tool_name, granted_at, expires_at FROM tool_permission_grants').all();
    expect(row).toEqual([{ tool_name: 'Bash', granted_at: now, expires_at: now + TOOL_GRANT_TIERS.TIER_24H_MS }]);
    expect(matchToolGrant(null, 'Bash', null, now + 1)).toBe('24h');
    expect(matchToolGrant(null, 'Bash', null, now + TOOL_GRANT_TIERS.TIER_24H_MS - 1)).toBe('24h');
    expect(matchToolGrant(null, 'Bash', null, now + TOOL_GRANT_TIERS.TIER_24H_MS)).toBeNull();
  });

  it.each([
    ['forceConfirm', { tool: 'Bash', payload: { forceConfirm: true } }, 'editable/forceConfirm/untargeted-external'],
    ['editable tool', { tool: 'mail_send', args: { to: 'a@b.c', subject: 's' } }, 'editable/forceConfirm/untargeted-external'],
    ['untargeted external', { tool: 'mcp__lark__send_message', args: { text: 'hi' } }, 'editable/forceConfirm/untargeted-external'],
    ['sensitiveStep', { payload: { sensitiveStep: { kind: 'password' as const } } }, 'Sensitive step'],
    ['browser tool', { tool: 'browser_action', args: { action: 'open', url: 'https://example.com' } }, 'browser tools'],
    ['cua-driver click without persisted app identity', { tool: 'mcp__cua-driver__click', args: { pid: 4242, x: 10, y: 20 } }, 'computer-use app target'],
    ['cua-driver launch_app without persisted app identity', { tool: 'mcp__cua-driver__launch_app', args: { bundle_id: 'com.apple.finder' } }, 'computer-use app target'],
    ['cua-driver with persisted app identity', { tool: 'mcp__cua-driver__type_text', args: { pid: 1, text: 'x' }, payload: { targetApp: { name: 'Notes' } } }, 'computer-use app target'],
    ['computer-use targetApp', { tool: 'computer_use', args: { action: 'click', targetApp: 'Finder' } }, 'computer-use app target'],
  ] as const)('%s: executes once, mints nothing, distinguishable warn', async (_name, input, warnPart) => {
    seed(input as Parameters<typeof seed>[0]);
    const outcome = await resume('allow_24h');
    expect(outcome).toMatchObject({ handled: true, status: 'executed' });
    expect(executions).toBe(1);
    expect(listToolGrants(now)).toEqual([]);
    expect(warnTexts().join('\n')).toContain(warnPart);
  });

  it('targeted external tool mints a target-scoped 24h grant', async () => {
    seed({ tool: 'mcp__lark__send_message', args: { text: 'hi' }, payload: { standingGrantTarget: 'chat-1' } });
    await resume('allow_24h');
    expect(matchToolGrant(null, 'mcp__lark__send_message', 'chat-1', now + 1)).toBe('24h');
    expect(matchToolGrant(null, 'mcp__lark__send_message', 'chat-2', now + 1)).toBeNull();
  });

  it('allow_run: executes once, mints nothing, warns allow_run + requestId + no run to attribute', async () => {
    seed();
    const outcome = await resume('allow_run');
    expect(outcome).toMatchObject({ handled: true, status: 'executed' });
    expect(executions).toBe(1);
    expect(listToolGrants(now)).toEqual([]);
    const call = warn.mock.calls.find((c) => String(c[0]).includes('allow_run after restart'));
    expect(call?.[0]).toContain('no run to attribute after restart');
    expect(call?.[1]).toMatchObject({ requestId: 'g-1' });
  });

  it('plain allow mints nothing', async () => {
    seed();
    await resume('allow');
    expect(listToolGrants(now)).toEqual([]);
  });

  it('double click mints at most once and executes once', async () => {
    seed();
    const [a, b] = await Promise.all([resume('allow_24h'), resume('allow_24h')]);
    expect([a, b].filter((o) => 'status' in o && o.status === 'executed')).toHaveLength(1);
    expect(executions).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_permission_grants').get()).toEqual({ n: 1 });
    // third click after the row left pending: no re-mint, no re-execute
    db.prepare('DELETE FROM tool_permission_grants').run();
    await resume('allow_24h');
    expect(listToolGrants(now)).toEqual([]);
    expect(executions).toBe(1);
  });

  it('fingerprint mismatch closes the row and mints nothing', async () => {
    seed({ fingerprintArgs: { command: 'something else' } });
    const outcome = await resume('allow_24h');
    expect(outcome).toMatchObject({ handled: true, status: 'closed' });
    expect(executions).toBe(0);
    expect(listToolGrants(now)).toEqual([]);
  });

  it('expired row (>24h since parked) mints nothing', async () => {
    seed({ requestedAt: now - TOOL_GRANT_TIERS.TIER_24H_MS - 1 });
    const outcome = await resume('allow_24h');
    expect(outcome.handled === false || outcome.status === 'closed').toBe(true);
    expect(executions).toBe(0);
    expect(listToolGrants(now)).toEqual([]);
  });

  it('unresolved working directory mints nothing', async () => {
    seed();
    const outcome = await resumeSurvivingParkedApproval({
      requestId: 'g-1', response: 'allow_24h', now, ports: { ...ports(), resolveWorkingDirectory: () => null },
    });
    expect(outcome).toMatchObject({ handled: true, status: 'closed' });
    expect(listToolGrants(now)).toEqual([]);
  });

  it('deny mints nothing', async () => {
    seed();
    await resume('deny');
    expect(listToolGrants(now)).toEqual([]);
  });
});
