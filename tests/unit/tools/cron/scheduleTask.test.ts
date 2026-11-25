import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/host/protocol/tools';
import { scheduleTaskModule } from '../../../../src/host/tools/modules/cron/scheduleTask';
import { acknowledgeScheduleDraft, clearScheduleDraftRequest, getScheduleDraftRequest } from '../../../../src/host/cron/scheduleDraftRequests';
import { SCHEDULE_DRAFT_ACK_TIMEOUT_MS } from '../../../../src/shared/constants/timeouts';
import type { ScheduleDraftRef } from '../../../../src/shared/ipc/schemas/cron';

const state = vi.hoisted(() => ({ unattended: false, origin: undefined as undefined | { kind: string }, missing: false, fails: false }));
vi.mock('../../../../src/host/permissions/modes', () => ({ getPermissionModeManager: () => ({ isUnattendedSession: () => state.unattended }) }));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({ getSessionManager: () => ({ getSession: async () => {
  if (state.fails) throw new Error('session read failed');
  return state.missing ? null : { origin: state.origin };
} }) }));

beforeEach(() => Object.assign(state, { unattended: false, origin: undefined, missing: false, fails: false }));

const sessionId = 'attended-session';
afterEach(() => {
  clearScheduleDraftRequest(sessionId);
  vi.useRealTimers();
});

function start(description: unknown, overrides: Partial<ToolContext> = {}) {
  let resolve!: (ref: ScheduleDraftRef) => void;
  const emitted = new Promise<ScheduleDraftRef>((finish) => { resolve = finish; });
  const emit = vi.fn<ToolContext['emit']>((event) => {
    if (event.type === 'schedule_draft_requested') resolve(event.data);
  });
  const result = Promise.resolve(scheduleTaskModule.createHandler()).then((handler) => handler.execute({ description }, {
    sessionId, abortSignal: new AbortController().signal, emit, ...overrides,
  } as ToolContext, vi.fn()));
  return { result, emit, emitted };
}

async function execute(description: unknown) {
  const run = start(description);
  return { result: await run.result, emit: run.emit };
}

function show(ref: ScheduleDraftRef) {
  expect(acknowledgeScheduleDraft({ ...ref, status: 'prepared', draft: { name: 'Weekly summary' } })).toBe(true);
  expect(acknowledgeScheduleDraft({ ...ref, status: 'shown' })).toBe(true);
}

describe('registered schedule_task module', () => {
  it('waits for the visible card ACK before returning success', async () => {
    const description = '每天9点汇总销售表';
    const run = start(description);
    const settled = vi.fn();
    void run.result.then(settled);
    const { requestId } = await run.emitted;
    const ref = { sessionId, requestId };
    expect(run.emit).toHaveBeenCalledExactlyOnceWith({ type: 'schedule_draft_requested', data: { ...ref, description } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    expect(acknowledgeScheduleDraft({ ...ref, status: 'shown' })).toBe(false);
    expect(acknowledgeScheduleDraft({ ...ref, status: 'prepared', draft: { name: 'Sales summary' } })).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    expect(acknowledgeScheduleDraft({ ...ref, status: 'shown' })).toBe(true);
    expect(await run.result).toMatchObject({ ok: true, output: expect.stringContaining('was displayed above the conversation input') });
    expect(getScheduleDraftRequest(sessionId)).toMatchObject({ ...ref, state: 'shown', draft: { name: 'Sales summary' } });
  });

  it('returns a stable generation error and removes the failed request', async () => {
    const run = start('weekly summary');
    const { requestId } = await run.emitted;
    expect(acknowledgeScheduleDraft({ sessionId, requestId, status: 'generation_failed' })).toBe(true);
    const result = await run.result;
    expect(result).toMatchObject({ ok: false, code: 'SCHEDULE_DRAFT_GENERATION_FAILED', error: expect.stringContaining('no task was created') });
    expect(result.ok ? '' : result.error).not.toMatch(/earlier card|previous draft/i);
    expect(getScheduleDraftRequest(sessionId)).toBeNull();
  });

  it('mentions an earlier card only if the failed request replaced a shown draft', async () => {
    const first = start('weekly summary');
    show(await first.emitted);
    expect(await first.result).toMatchObject({ ok: true });

    const second = start('monthly summary');
    const { requestId } = await second.emitted;
    expect(acknowledgeScheduleDraft({ sessionId, requestId, status: 'generation_failed' })).toBe(true);
    expect(await second.result).toMatchObject({
      ok: false,
      code: 'SCHEDULE_DRAFT_GENERATION_FAILED',
      error: expect.stringContaining('The previous draft in this conversation was replaced by this request.'),
    });
  });

  it('times out an unprepared request and rejects a late renderer ACK', async () => {
    vi.useFakeTimers();
    const run = start('weekly summary');
    const { requestId } = await run.emitted;
    await vi.advanceTimersByTimeAsync(SCHEDULE_DRAFT_ACK_TIMEOUT_MS);
    expect(await run.result).toMatchObject({ ok: false, code: 'SCHEDULE_CARD_NOT_SHOWN', error: expect.stringContaining('no task was created') });
    expect(acknowledgeScheduleDraft({ sessionId, requestId, status: 'prepared', draft: {} })).toBe(false);
  });

  it('times out the tool while retaining a prepared draft for a later visible composer', async () => {
    vi.useFakeTimers();
    const run = start('weekly summary');
    const ref = await run.emitted;
    expect(acknowledgeScheduleDraft({ ...ref, status: 'prepared', draft: { name: 'Weekly summary' } })).toBe(true);
    await vi.advanceTimersByTimeAsync(SCHEDULE_DRAFT_ACK_TIMEOUT_MS);
    expect(await run.result).toMatchObject({ ok: false, code: 'SCHEDULE_CARD_NOT_SHOWN' });
    expect(getScheduleDraftRequest(sessionId)).toMatchObject({ state: 'prepared', draft: { name: 'Weekly summary' } });
    expect(acknowledgeScheduleDraft({ ...ref, status: 'shown' })).toBe(true);
    expect(getScheduleDraftRequest(sessionId)).toMatchObject({ state: 'shown' });
  });

  it('reports dismissal if the user cancels before the visibility ACK arrives', async () => {
    const run = start('weekly summary');
    const ref = await run.emitted;
    expect(acknowledgeScheduleDraft({ ...ref, status: 'prepared', draft: { name: 'Weekly summary' } })).toBe(true);
    expect(acknowledgeScheduleDraft({ ...ref, status: 'discarded' })).toBe(true);
    expect(await run.result).toMatchObject({ ok: false, code: 'SCHEDULE_DRAFT_DISCARDED' });
    expect(getScheduleDraftRequest(sessionId)).toBeNull();
  });

  it('cancels a waiting draft when the tool is aborted', async () => {
    const controller = new AbortController();
    const run = start('weekly summary', { abortSignal: controller.signal });
    await run.emitted;
    controller.abort();
    expect(await run.result).toMatchObject({ ok: false, code: 'ABORTED' });
    expect(getScheduleDraftRequest(sessionId)).toBeNull();
  });

  it('invalidates a superseded request without clearing its replacement', async () => {
    const first = start('weekly summary');
    const old = await first.emitted;
    const next = start('monthly summary');
    const current = await next.emitted;
    expect(await first.result).toMatchObject({ ok: false, code: 'SCHEDULE_CARD_NOT_SHOWN' });
    expect(acknowledgeScheduleDraft({ ...old, status: 'generation_failed' })).toBe(false);
    show(current);
    expect(await next.result).toMatchObject({ ok: true });
  });
  it.each(['cron', 'wake', 'channel', 'webhook', 'voice', 'heartbeat'])('refuses external origin %s without emitting', async (kind) => {
    state.origin = { kind };
    const { result, emit } = await execute('每天9点汇总销售表');
    expect(result).toMatchObject({ ok: false, code: 'ATTENDED_SESSION_REQUIRED' });
    expect(emit).not.toHaveBeenCalled();
  });
  it('refuses unattended runs without emitting', async () => {
    state.unattended = true;
    const { result, emit } = await execute('every day summarize sales');
    expect(result.ok).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
  it.each(['manual', 'retry'])('allows attended %s sessions', async (kind) => {
    state.origin = { kind };
    const run = start('weekly summary');
    show(await run.emitted);
    expect((await run.result).ok).toBe(true);
  });
  it.each(['missing', 'fails'] as const)('fails closed on %s session lookup', async (key) => {
    state[key] = true;
    const { result, emit } = await execute('weekly summary');
    expect(result.ok).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
  it.each(['', undefined, 42])('rejects invalid description %s', async (description) => {
    const { result, emit } = await execute(description);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(emit).not.toHaveBeenCalled();
  });
});
