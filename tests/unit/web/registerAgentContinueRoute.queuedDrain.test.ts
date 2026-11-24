// @vitest-environment jsdom
import express from 'express';
import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { QueuedInputRepository } from '../../../src/host/services/core/repositories/QueuedInputRepository';
import { armQuotaWaitOnPark, registerQuotaWaitContinuer } from '../../../src/host/runtime/quotaWaitTimer';
import type { Message } from '../../../src/shared/contract';
import { registerAgentContinueRoute } from '../../../src/web/routes/registerAgentContinueRoute';
import { createWebQueuedInputDrain, releaseThenTriggerWebQueuedInputDrain } from '../../../src/web/routes/webQueuedInputDrain';

const SESSION = 'session-parked';

describe('continue route drains queued inputs when the resumed run settles', () => {
  const databases: BetterSqlite3.Database[] = [];
  let server: http.Server | undefined;

  afterEach(async () => {
    registerQuotaWaitContinuer(null);
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    for (const db of databases.splice(0)) db.close();
  });

  function setup(opts: { hasParked?: boolean } = {}) {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE queued_inputs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, envelope_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', retry_count INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0, paused_reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX idx_queued_inputs_session ON queued_inputs (session_id, status, created_at);`);
    databases.push(db);
    const repository = new QueuedInputRepository(db);
    let active = false;
    const ran: string[] = [];
    const drain = createWebQueuedInputDrain({
      getRepository: () => repository,
      hasActiveRun: () => active,
      runEnvelope: async (envelope) => { ran.push(envelope.content); },
      emitAgentEvent: () => undefined,
      notifyQueuedInputActivated: () => undefined,
      notifyQueuedInputSettled: () => undefined,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const source: Message = { id: 'source-1', role: 'user', content: 'go', timestamp: 1, metadata: {} };
    const hasParked = opts.hasParked ?? true;
    const registry = {
      findRecoveredWaitingRun: () => (hasParked ? { runId: 'run-parked', sessionId: SESSION } : undefined),
      getDurableCheckpointState: () => ({ sourceMessageId: source.id }),
      resetDurableResumeBudget: async () => undefined,
      parkDurable: async () => undefined,
    };
    let finishResume!: () => void;
    const taskManager = {
      getSessionState: () => ({ status: 'idle' as const }),
      resumeExistingDurableRun: () => new Promise<void>((resolve) => {
        active = true;
        finishResume = () => { active = false; resolve(); };
      }),
    };
    const router = express.Router();
    registerAgentContinueRoute(router, registry as never, () => taskManager as never, async () => [source],
      undefined, drain.handleReleasedSession);
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    server = http.createServer(app);
    const ready = new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const enqueue = () => {
      repository.enqueue({ id: 'q1', sessionId: SESSION, envelope: { content: '追加一条', sessionId: SESSION }, now: 1 });
      drain.handleEnqueued(SESSION);
    };
    const post = async () => {
      await ready;
      const addr = server!.address() as { port: number };
      return fetch(`http://127.0.0.1:${addr.port}/api/continue`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: SESSION }),
      });
    };
    return { repository, ran, drain, enqueue, post, finish: () => finishResume(), setActive: (v: boolean) => { active = v; } };
  }

  it('(a) normal run release with a queued row sends it', async () => {
    const t = setup();
    t.enqueue();
    await releaseThenTriggerWebQueuedInputDrain({ release: async () => undefined, sessionId: SESSION, triggerDrain: t.drain.handleReleasedSession });
    await vi.waitFor(() => expect(t.ran).toEqual(['追加一条']));
    expect(t.repository.getById('q1')?.status).toBe('consumed');
  });

  it('(b) row queued while the resumed run is active is sent after the resume resolves', async () => {
    const t = setup();
    const response = t.post();
    await vi.waitFor(() => expect(typeof t.finish).toBe('function'));
    await new Promise((r) => setTimeout(r, 20));
    t.enqueue();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.ran).toEqual([]);
    expect(t.repository.getById('q1')?.status).toBe('queued');
    t.finish();
    expect((await response).status).toBe(200);
    await vi.waitFor(() => expect(t.ran).toEqual(['追加一条']));
    expect(t.repository.getById('q1')?.status).toBe('consumed');
  });

  it('(c) continue that throws "No parked durable run" does not trigger drain', async () => {
    const t = setup({ hasParked: false });
    t.setActive(true); // another run owns the session
    t.enqueue();
    const res = await t.post();
    expect(res.status).toBe(409);
    t.setActive(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.ran).toEqual([]);
    expect(t.repository.getById('q1')?.status).toBe('queued');
  });

  it('(d) quota-wait continuer triggers drain after the resumed run resolves', async () => {
    const t = setup();
    armQuotaWaitOnPark({ runId: 'run-parked', sessionId: SESSION, dueAt: Date.now() + 10 });
    await new Promise((r) => setTimeout(r, 60));
    t.enqueue();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.ran).toEqual([]);
    t.finish();
    await vi.waitFor(() => expect(t.ran).toEqual(['追加一条']));
    expect(t.repository.getById('q1')?.status).toBe('consumed');
  });
});
