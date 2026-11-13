import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequestData } from '../../../src/host/tools/types';

// 复用 toolExecutor.permissionBoundary.test.ts 的 mock 套路：
// 通过 requestPermission spy 捕获 buildPermissionRequest 产出的 request 对象。
const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/host/security/writeIsolation', () => ({
  getWriteIsolationManager: () => ({
    acquire: vi.fn(async () => () => {}),
  }),
  getWriteIsolationScope: () => null,
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, createLogger: () => logger };
});

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { SessionDelegationRepository } from '../../../src/host/services/core/repositories/SessionDelegationRepository';
import { projectSessionCandidates } from '../../../src/host/services/delegation/delegationCandidates';
import { delegateSessionSchema } from '../../../src/host/tools/modules/delegation/delegateSession.schema';
import { ConfirmationGate } from '../../../src/host/agent/confirmationGate';
import { createLogger } from '../../../src/host/services/infra/logger';

const runtime = vi.hoisted(() => ({
  listSessions: vi.fn(), getSessionRow: vi.fn(), getDb: vi.fn(), now: () => 1_000,
}));
vi.mock('../../../src/host/services/delegation/delegationToolRuntime', () => ({
  getDelegationToolRuntime: () => runtime,
  getDelegationCandidateSecret: () => 'approval-test-secret',
}));
const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');

let db: Database.Database;
const target = { id: 'target', title: '购物清单', updatedAt: 1_000 };
const projection = projectSessionCandidates([target], {
  originSessionId: 'origin', now: 1_000, secret: 'approval-test-secret',
});
const reference = { candidateSetId: projection.candidateSetId, candidateRef: projection.candidates[0].candidateRef };

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  applySchema(db, createLogger('test'));
  runtime.getDb.mockReturnValue(db);
  runtime.listSessions.mockReturnValue([target]);
  runtime.getSessionRow.mockReturnValue(target);
  resolverState.getDefinition.mockReturnValue({ ...delegateSessionSchema, requiresPermission: true });
  new SessionDelegationRepository(db).insertOrGet({
    delegationId: 'delegation', originSessionId: 'origin', originTurnId: 'turn',
    disposition: 'delegate_existing', targetSessionId: 'target',
    submissionKey: 'submission', actionFingerprint: 'fingerprint', createdAt: 1_000,
  });
});
afterEach(() => db.close());

async function capture(params: Record<string, unknown>) {
  const requestPermission = vi.fn<(request: PermissionRequestData) => Promise<boolean>>(async () => false);
  const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
  executor.setAuditEnabled(false);
  await executor.execute('delegate_session', params, {
    sessionId: 'origin', skillToolBoundary: { skillName: 'test', allowedTools: ['Read'] },
  });
  expect(requestPermission).toHaveBeenCalledOnce();
  return requestPermission.mock.calls[0][0];
}

describe('delegation approval production entries', () => {
  it.each([
    ['delegate_existing', '把这句话转给会话「购物清单」'],
    ['create_new', '新建一个会话来处理这句话'],
    ['correct', '更正转给会话「购物清单」的任务'],
    ['stop', '停止转给会话「购物清单」的任务'],
    ['resume', '继续转给会话「购物清单」的任务'],
  ])('%s names its concrete action without a tool name', async (action, summary) => {
    const request = await capture({ action, ...reference, delegationId: 'delegation', text: '加上果酱' });
    expect(request.reason).toBe(summary);
    expect(request.details.preview).toEqual({ type: 'generic', summary, diff: '内容：加上果酱' });
    expect(request.type).toBe('command');
    expect(request.boundary?.id).toBe('command.shell');
    expect(JSON.stringify([request.reason, request.details.preview])).not.toContain('delegate_session');
  });

  it.each([
    ['set_missing', {}],
    ['set_stale', { ...reference, candidateSetId: 'stale' }],
    ['ref_not_found', { ...reference, candidateRef: 'missing' }],
    ['session_gone', reference],
    ['title_missing', reference],
    ['lookup_failed', reference],
  ])('unresolved target uses neutral copy and warns: %s', async (cause, ref) => {
    if (cause === 'session_gone') runtime.getSessionRow.mockReturnValue(null);
    if (cause === 'title_missing') runtime.getSessionRow.mockReturnValue({ ...target, title: '' });
    if (cause === 'lookup_failed') runtime.listSessions.mockImplementationOnce(() => { throw new Error('unavailable'); });
    const request = await capture({ action: 'delegate_existing', ...ref, text: '加上果酱' });
    expect(request.reason).toBe('把这句话转给另一个会话');
    expect(request.details.preview?.summary).toBe(request.reason);
    expect(createLogger('test').warn).toHaveBeenCalledWith('Delegation approval target unavailable', { cause });
    expect(JSON.stringify([request.reason, request.details.preview])).not.toContain('delegate_session');
    process.stdout.write(`${JSON.stringify(vi.mocked(createLogger('test').warn).mock.calls.at(-1))}\n`);
  });

  it('does not reveal a chain belonging to another origin', async () => {
    db.prepare("UPDATE session_delegations SET origin_session_id = 'other'").run();
    const request = await capture({ action: 'stop', delegationId: 'delegation' });
    expect(request.reason).toBe('停止转给另一个会话的任务');
  });

  it('redacts secrets before truncating long text in the real request', async () => {
    runtime.getSessionRow.mockReturnValue({ ...target, title: '购物清单 token=hidden-title' });
    const request = await capture({ action: 'delegate_existing', ...reference, text: 'password=hidden-value ' + '加果酱'.repeat(200) });
    const preview = JSON.stringify(request.details.preview);
    expect(preview).not.toContain('hidden-value');
    expect(preview).not.toContain('hidden-title');
    expect(preview).toContain('***REDACTED***');
    expect(request.details.preview?.diff?.length).toBeLessThanOrEqual(203);
  });

  it('ConfirmationGate keeps every delegation action out of the default preview even without lookup', () => {
    const gate = new ConfirmationGate();
    for (const action of ['delegate_existing', 'create_new', 'correct', 'stop', 'resume']) {
      const preview = gate.buildPreview('delegate_session', { action, text: '加上果酱' });
      expect(preview?.summary).not.toBe('执行工具 delegate_session');
      expect(JSON.stringify(preview)).not.toContain('delegate_session');
    }
  });
});
