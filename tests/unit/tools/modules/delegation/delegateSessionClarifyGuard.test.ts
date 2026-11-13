import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');

const loggerInfo = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock('../../../../../src/host/observability/posthogNode', () => ({ trackNode: vi.fn() }));
vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../../../src/host/services/infra/logger')>();
  return { ...mod, createLogger: () => ({ info: loggerInfo, warn: loggerWarn, error: () => {}, debug: () => {} }) };
});

import { applySchema } from '../../../../../src/host/services/core/database/schema';
import { getDelegationCandidateSecret } from '../../../../../src/host/services/delegation/delegationToolRuntime';
import { projectSessionCandidates } from '../../../../../src/host/services/delegation/delegationCandidates';
import { executeDelegateSession } from '../../../../../src/host/tools/modules/delegation/delegateSession';

const ctx = {
  sessionId: 'origin', turnId: 'turn-1', workingDir: '/workspace/origin',
  workspace: '/workspace/origin', modelConfig: { provider: 'local', model: 'test' },
  workspaceScope: { projectId: 'p', primaryRoot: '/workspace/origin', roots: [{ sourceId: 's', path: '/workspace/origin', access: 'read_write', role: 'primary' }], version: '1' },
  abortSignal: new AbortController().signal,
} as never;

const NOW = 100;
const sessions = [
  { id: 'sid-cli', title: 'CLI重构', workingDirectory: '/workspace/origin', updatedAt: NOW, sessionType: 'chat' as const, engineKind: 'native' },
  { id: 'sid-ui', title: '组件库重构', workingDirectory: '/workspace/origin', updatedAt: NOW - 1, sessionType: 'chat' as const, engineKind: 'native' },
  { id: 'sid-docs', title: '文档站', workingDirectory: '/workspace/origin', updatedAt: NOW - 2, sessionType: 'chat' as const, engineKind: 'native' },
];

function setup(userMessage: string | null) {
  const db = new Database(':memory:');
  applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
  if (userMessage !== null) {
    db.prepare(`INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at) VALUES ('origin', 'origin', 'local', 'test', ?, ?)`).run(NOW, NOW);
    db.prepare(`INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('m-1', 'origin', 'user', ?, ?)`).run(userMessage, NOW);
  }
  const projection = projectSessionCandidates(sessions, { originSessionId: 'origin', now: NOW, secret: getDelegationCandidateSecret() });
  const refOf = (title: string) => projection.candidates[sessions.findIndex((row) => row.title === title)].candidateRef;
  (ctx as unknown as { delegationRuntime?: unknown }).delegationRuntime = {
    getDb: () => db,
    listSessions: () => sessions,
    getSessionRow: (id: string) => {
      const row = sessions.find((entry) => entry.id === id);
      return row ? { ...row, modelConfig: { provider: 'local', model: 'test' } } : null;
    },
    getWorkspaceRoots: () => ['/workspace'],
    getRuns: () => [],
    getRun: () => undefined,
    getPermissionMode: () => 'default',
    evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
    notifyEnqueued: vi.fn(),
    now: () => NOW,
  };
  const rows = () => ({
    delegations: (db.prepare('SELECT count(*) AS count FROM session_delegations').get() as { count: number }).count,
    queued: (db.prepare('SELECT count(*) AS count FROM queued_inputs').get() as { count: number }).count,
  });
  return { db, projection, refOf, rows };
}

afterEach(() => {
  delete process.env.CODE_AGENT_CROSS_SESSION_DELEGATION;
  (ctx as unknown as { delegationRuntime?: unknown }).delegationRuntime = undefined;
  loggerInfo.mockClear();
  loggerWarn.mockClear();
});

const allow = async () => ({ allow: true as const });

describe('delegate_session clarify guard (needs_clarification)', () => {
  it('fires on an ambiguous reference: structured rejection with display names, no row written', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup('让重构那边看看这个报错');
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('CLI重构'), text: '看看这个报错' }, ctx, allow);
    expect(result).toMatchObject({ ok: false, code: 'DELEGATION_REJECTED', meta: { code: 'needs_clarification', gate: 'none' } });
    const error = (result as { error: string }).error;
    expect(error).toContain('needs_clarification');
    expect(error).toContain('AskUserQuestion');
    expect(error).toContain('「CLI重构」');
    expect(error).toContain('「组件库重构」');
    for (const row of sessions) expect(error).not.toContain(row.id);
    expect(error).not.toContain(refOf('CLI重构'));
    expect(rows()).toEqual({ delegations: 0, queued: 0 });
    expect(loggerInfo).toHaveBeenCalledWith('[DelegateSession] outcome', expect.objectContaining({ outcome: 'rejected', code: 'needs_clarification' }));
    db.close();
  });

  it('does not fire on a uniquely named target: delegates once', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup('让文档站把本周变更记录整理一下');
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('文档站'), text: '整理本周变更记录' }, ctx, allow);
    expect(result.ok).toBe(true);
    expect(rows()).toEqual({ delegations: 1, queued: 1 });
    expect(loggerInfo).toHaveBeenCalledWith('[DelegateSession] outcome', expect.objectContaining({ outcome: 'ok', code: 'ok' }));
    db.close();
  });

  it('fires when the model picked a different chat than the one the user named', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup('让文档站把本周变更记录整理一下');
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('CLI重构'), text: '整理本周变更记录' }, ctx, allow);
    expect(result).toMatchObject({ ok: false, meta: { code: 'needs_clarification' } });
    expect(rows()).toEqual({ delegations: 0, queued: 0 });
    db.close();
  });

  it('fires on create_new when the user never asked for a new chat', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, rows } = setup('找个会话研究一下这个协议设计');
    const result = await executeDelegateSession({ action: 'create_new', text: '研究协议设计' }, ctx, allow);
    expect(result).toMatchObject({ ok: false, meta: { code: 'needs_clarification' } });
    expect(rows()).toEqual({ delegations: 0, queued: 0 });
    db.close();
  });

  it('skips message-based rules, with a trace, when the user message is unreachable', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup(null);
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('CLI重构'), text: '看看这个报错' }, ctx, allow);
    expect(result.ok).toBe(true);
    expect(rows().delegations).toBe(1);
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('no readable origin user message'));
    db.close();
  });
});
