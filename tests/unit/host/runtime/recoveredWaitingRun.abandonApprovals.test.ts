// 放弃（abandonParked）停靠 run 后，它名下 pending 的工具审批行必须收尾，
// 否则聊天底部会一直挂着已死任务的「请求批准」卡（真机 en3：run 已 cancelled，卡仍在）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applyTestSessionSchema } from '../../../utils/applyTestSessionSchema';
import { PendingApprovalRepository } from '../../../../src/host/services/core/repositories/PendingApprovalRepository';
import { terminalRecoveredWaitingRunOnce } from '../../../../src/host/runtime/recoveredWaitingRun';

const state = vi.hoisted(() => ({ repo: null as unknown }));
vi.mock('../../../../src/host/services/infra/logger', () => {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: () => logger, logger };
});
vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: true, getSession: () => null, getPendingApprovalRepo: () => state.repo }),
}));

let db: Database.Database;
let repo: PendingApprovalRepository;
const insert = (id: string, sessionId: string, extra: Record<string, unknown> = {}) => repo.insert({
  id, kind: 'tool_approval', agentId: null, agentName: null, coordinatorId: sessionId,
  payload: { sessionId, toolCallId: `call-${id}`, tool: 'Write', ...extra }, submittedAt: 1,
});
const status = (id: string) => (db.prepare('SELECT status, feedback FROM pending_approvals WHERE id = ?').get(id) as { status: string; feedback: string });
const registry = () => ({
  findRecoveredWaitingRun: () => ({ runId: 'run-1', sessionId: 's1' }),
  terminalDurable: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  db = new Database(':memory:');
  applyTestSessionSchema(db);
  repo = new PendingApprovalRepository(db);
  state.repo = repo;
});
afterEach(() => db.close());

describe('terminalRecoveredWaitingRunOnce abandonParked', () => {
  it('rejects the abandoned session\'s pending tool approvals and leaves other sessions alone', async () => {
    insert('mine', 's1');
    insert('other', 's2');
    await terminalRecoveredWaitingRunOnce(registry(), new Map(), { sessionId: 's1' }, 10, { abandonParked: true });
    expect(status('mine')).toEqual({ status: 'rejected', feedback: 'run cancelled' });
    expect(status('other').status).toBe('pending');
  });

  it('leaves background-lane approvals of the same session pending (their in-memory waiter is alive)', async () => {
    insert('fg', 's1');
    insert('bg', 's1', { backgroundLane: true });
    await terminalRecoveredWaitingRunOnce(registry(), new Map(), { sessionId: 's1' }, 10, { abandonParked: true });
    expect(status('fg').status).toBe('rejected');
    expect(status('bg').status).toBe('pending');
  });

  it('does not touch approvals on a plain Stop (no abandonParked)', async () => {
    insert('mine', 's1');
    await terminalRecoveredWaitingRunOnce(registry(), new Map(), { sessionId: 's1' }, 10);
    expect(status('mine').status).toBe('pending');
  });
});
