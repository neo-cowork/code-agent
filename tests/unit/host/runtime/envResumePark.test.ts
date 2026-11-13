import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import * as continuation from '../../../../src/host/app/durableRunContinuation';
import { harness, databasePorts } from './envResumeHarness';
import { registerEnvResumeContinuer, armEnvResumeOnPark } from '../../../../src/host/runtime/envResumeWaiter';
import { ENV_RESUME_TIMEOUT_MS, ENV_RESUME_POLL_INTERVAL_MS } from '../../../../src/shared/constants/envResume';
import { mapDurableRunView, projectDurableRunToSessionPayload } from '../../../../src/host/app/durableRunReadService';
import { assertRunEnvelope, withRunInterruptMetadata } from '../../../../src/shared/contract/durableRun';

vi.mock('../../../../src/host/services/core/databaseService', () => ({ getDatabase: () => databasePorts.current }));
const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => ({ ...await importOriginal<typeof import('../../../../src/host/services/infra/logger')>(), createLogger: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: (...args: unknown[]) => { warn(...args); process.stdout.write(`WARN ${JSON.stringify(args)}\n`); } }) }));

let fixture: Awaited<ReturnType<typeof harness>> | undefined;
let workspace: string;
afterEach(() => { fixture?.close(); fixture = undefined; registerEnvResumeContinuer(null); vi.useRealTimers(); vi.restoreAllMocks(); warn.mockClear(); if (workspace) rmSync(workspace, { recursive: true, force: true }); });
async function setup(write = false) {
  vi.useFakeTimers();
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'env-resume-')));
  fixture = await harness(workspace, ':memory:', write);
  return fixture;
}

describe('environment parks through production engine, finalizer, registry and continuation', () => {
  it('route hookup continues once after red -> green with same run/call and no repeated user message', async () => {
    const f = await setup();
    const continueSpy = vi.spyOn(continuation, 'continueParkedDurableRun');
    let green = false;
    f.wire(async () => green ? 'green' : 'red');
    const { emitted } = await f.park();
    expect(emitted.some((event) => ['error', 'tool_call_end', 'env_assist_notice'].includes(event.type ?? ''))).toBe(false);
    expect(await f.repository.get('env-run')).toMatchObject({ status: 'waiting', interruptCause: 'env_blocked', envBlocked: { class: 'perm_automation', target: 'mail', toolCallId: 'env-call' }, pendingOperations: [{ status: 'dispatched' }] });
    expect(f.db.prepare("SELECT * FROM tool_execution_events WHERE phase='complete'").all()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(ENV_RESUME_POLL_INTERVAL_MS * 2);
    expect(f.counts()).toMatchObject({ executions: 1, resumes: 0 });
    f.green(); green = true;
    await vi.advanceTimersByTimeAsync(ENV_RESUME_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(f.counts().resumes).toBe(1));
    expect(f.counts()).toEqual({ executions: 2, resumes: 1, seenCalls: ['env-call', 'env-call'], seenRuns: ['env-run', 'env-run'] });
    expect(await f.repository.get('env-run')).toMatchObject({ status: 'completed' });
    expect(f.messages().filter((message) => message.role === 'user')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ENV_RESUME_TIMEOUT_MS * 2);
    expect(f.counts().resumes).toBe(1);
    expect(continueSpy).toHaveBeenCalledTimes(1);
    expect(continueSpy).toHaveBeenCalledWith(expect.objectContaining({ expectedRunId: 'env-run', sessionId: 'env-session' }));
    expect(warn).not.toHaveBeenCalled();
    process.stdout.write(`CONTINUE_CALLS ${JSON.stringify({ count: continueSpy.mock.calls.length, runId: continueSpy.mock.calls[0][0].expectedRunId })}\n`);
    f.dump();
  });

  it('never re-executes a sideEffect tool; the model receives an interrupted result', async () => {
    const f = await setup(true);
    f.wire(async () => 'red'); await f.park();
    f.green(); await f.continueRun();
    expect(f.counts()).toMatchObject({ executions: 1, resumes: 1 });
    expect(f.messages().find((message) => message.role === 'tool')?.toolResults?.[0]).toMatchObject({ toolCallId: 'env-call', success: false, error: expect.stringContaining('interrupted:') });
    expect((await f.repository.get('env-run'))?.pendingOperations?.[0]).toMatchObject({ status: 'succeeded', sideEffect: true, resultRef: expect.stringContaining('interrupted-tool-result:env-call') });
    f.dump(); process.stdout.write(`PENDING_OPERATIONS ${JSON.stringify((await f.repository.get('env-run'))?.pendingOperations)}\n`);
  });

  it.each(['red', 'unavailable', 'hung'] as const)('bounds %s probes and leaves manual Continue available', async (kind) => {
    const f = await setup();
    f.wire(() => kind === 'hung' ? new Promise(() => {}) : Promise.resolve(kind)); await f.park();
    await vi.advanceTimersByTimeAsync(ENV_RESUME_TIMEOUT_MS + 1);
    const envelope = (await f.repository.get('env-run'))!;
    expect(envelope.status).toBe('waiting');
    expect(projectDurableRunToSessionPayload(mapDurableRunView('session_replay', envelope)).durableResume).toMatchObject({ canContinue: true, mode: 'continue', interruptCause: 'env_blocked' });
    expect(warn).toHaveBeenCalledWith('Environment auto-continue stopped', expect.objectContaining({ reason: kind === 'unavailable' ? 'probe_unavailable' : 'timeout' }));
    expect(f.counts().resumes).toBe(0);
    f.green(); await f.continueRun();
    expect((await f.repository.get('env-run'))?.status).toBe('completed');
  });

  it('continuer failure warns and does not restart polling or lose the park metadata', async () => {
    const f = await setup(); await f.park();
    registerEnvResumeContinuer(async () => { throw new Error('injected continuer failure'); }, () => async () => 'green');
    armEnvResumeOnPark({ runId: 'env-run', sessionId: 'env-session', envBlocked: (await f.repository.get('env-run'))!.envBlocked! });
    await vi.advanceTimersByTimeAsync(ENV_RESUME_TIMEOUT_MS * 3);
    expect(warn).toHaveBeenCalledWith('Environment auto-continue stopped', expect.objectContaining({ reason: 'continuer_failed' }));
    expect((await f.repository.get('env-run'))?.interruptCause).toBe('env_blocked');
  });

  it('can manually continue after a failed live-loop handoff without replaying an already settled tool', async () => {
    const f = await setup();
    const resume = f.tasks.resumeExistingDurableRun.bind(f.tasks);
    f.tasks.resumeExistingDurableRun = async () => { throw new Error('injected live-loop handoff failure'); };
    f.wire(async () => 'green'); await f.park(); f.green();
    await vi.advanceTimersByTimeAsync(ENV_RESUME_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('Environment auto-continue stopped', expect.objectContaining({ reason: 'continuer_failed' })));
    expect(await f.repository.get('env-run')).toMatchObject({ status: 'waiting', interruptCause: 'env_blocked', envBlocked: { toolCallId: 'env-call' } });
    await vi.advanceTimersByTimeAsync(ENV_RESUME_TIMEOUT_MS * 2);
    expect(f.counts().executions).toBe(2);
    f.tasks.resumeExistingDurableRun = resume;
    await f.continueRun();
    expect(f.counts()).toMatchObject({ executions: 2, resumes: 1 });
    expect((await f.repository.get('env-run'))?.status).toBe('completed');
  });

  it('clears polling on user cancellation, including a late green probe', async () => {
    const f = await setup();
    let green!: (value: 'green') => void;
    f.wire(() => new Promise((resolve) => { green = resolve; })); await f.park();
    await vi.advanceTimersByTimeAsync(ENV_RESUME_POLL_INTERVAL_MS);
    await f.registry.terminalRecoveredWaitingRun({ runId: 'env-run' });
    green('green'); await vi.advanceTimersByTimeAsync(ENV_RESUME_TIMEOUT_MS * 2);
    expect(f.counts()).toMatchObject({ executions: 1, resumes: 0 });
    expect((await f.repository.get('env-run'))?.status).toBe('cancelled');
  });

  it('rejects a superseded source before replaying the blocked operation', async () => {
    const f = await setup(); f.wire(async () => 'red'); await f.park(); f.green();
    f.db.prepare('INSERT INTO messages (id,session_id,role,content,timestamp) VALUES (?,?,?,?,?)').run('new-user', 'env-session', 'user', 'New instruction', Date.now());
    await expect(f.continueRun()).rejects.toThrow('not the latest user turn');
    expect(f.counts()).toMatchObject({ executions: 1, resumes: 0 });
    expect((await f.repository.get('env-run'))?.status).toBe('waiting');
  });

  it('validates blocker fields and removes metadata when the cause changes', async () => {
    const f = await setup(); await f.park();
    const envelope = (await f.repository.get('env-run'))!;
    expect(() => assertRunEnvelope(envelope)).not.toThrow();
    for (const envBlocked of [undefined, { ...envelope.envBlocked!, class: 'invalid' }, { ...envelope.envBlocked!, target: '' }, { ...envelope.envBlocked!, toolCallId: '' }]) {
      expect(() => assertRunEnvelope({ ...envelope, envBlocked } as typeof envelope)).toThrow();
    }
    expect(withRunInterruptMetadata(envelope, { clearInterruptCause: true }).envBlocked).toBeUndefined();
    expect(withRunInterruptMetadata(envelope, { interruptCause: 'user_stop' }).envBlocked).toBeUndefined();
  });
});
