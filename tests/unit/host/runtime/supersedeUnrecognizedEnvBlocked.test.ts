import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/services/infra/logger')>(),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn }),
}));

import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';

/**
 * N-FIX-SEND-HANGS-WHEN-PARKED-RUN-SUPERSEDE-FAILS：停在 env_blocked 的 run 若停靠类别本版本不认识
 * （另一版本的包写进库的 perm_calendars、数据损坏、未来新类别），新消息让位仍要把它取消掉，
 * 否则它永远占着会话唯一约束 → 新一轮 RunSessionConflictError → 会话再也发不出消息。
 */
describe('new message supersedes a parked run whose envBlocked metadata this build does not recognize', () => {
  it.each([
    // perm_calendars 在本版本已是正式类别（N-CALENDAR-ONE-PERMISSION-EVENTKIT），换一个本版本确实不认识的类别
    ['unknown class from another build', { class: 'perm_from_a_future_build', target: 'calendar', toolCallId: 'call-1' }],
    ['missing target', { class: 'perm_files', target: '', toolCallId: 'call-1' }],
    ['null metadata', null],
  ])('%s: supersede cancels it and the session can start a new run', async (_label, envBlocked) => {
    warn.mockClear();
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'supersede-unknown-env-')));
    const db = new Database(':memory:');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    const kernelFor = (processInstanceId: string) => new DurableRunKernel({
      stores: repository, ownerId: 'native-host', processInstanceId, leaseDurationMs: 100,
    });
    const sessionId = 'session-unknown-env';
    const runId = 'run-unknown-env';
    const before = new RunRegistry();
    before.configureDurableKernel(kernelFor('other-build'));
    const after = new RunRegistry();
    try {
      // 另一版本写进库的停靠：先按合法类别停好，再把库里的 envelope 改成本版本不认识的样子。
      const handle = await before.startDurable({ runId, sessionId, workspace, cwd: workspace }, 1_000);
      await before.checkpointDurable(runId, {
        now: 1_010, status: 'waiting', state: before.getDurableCheckpointState(runId),
        pendingOperations: [], interruptCause: 'env_blocked',
        envBlocked: { class: 'perm_files', target: 'files', toolCallId: 'call-1' },
        events: [{ type: 'run_interrupted', payload: { cause: 'env_blocked' }, recordedAt: 1_010 }],
      });
      before.unregister(runId, handle);
      before.clear();
      const row = db.prepare('SELECT envelope_json FROM durable_runs WHERE run_id = ?').get(runId) as { envelope_json: string };
      db.prepare('UPDATE durable_runs SET envelope_json = ? WHERE run_id = ?')
        .run(JSON.stringify({ ...JSON.parse(row.envelope_json), envBlocked }), runId);

      after.configureDurableKernel(kernelFor('this-build'));
      await after.recoverDurable(2_000);
      expect(await repository.get(runId)).toMatchObject({ status: 'waiting', interruptCause: 'env_blocked' });

      await after.supersedeParkedSessionRoots(sessionId, 2_050);
      expect(await repository.get(runId)).toMatchObject({
        status: 'cancelled', terminal: { status: 'cancelled' },
      });
      const next = await after.startDurable({ runId: 'run-after-supersede', sessionId, workspace, cwd: workspace }, 2_060);
      expect(next.context.runId).toBe('run-after-supersede');
      expect(warn).toHaveBeenCalledWith(
        'Superseding parked durable run with unrecognized park metadata',
        expect.objectContaining({ sessionId, runId, error: 'Invalid envBlocked metadata' }),
      );
      expect(warn).not.toHaveBeenCalledWith('Failed to supersede parked durable run', expect.anything());
    } finally {
      after.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });
});
