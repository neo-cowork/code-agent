import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/host/protocol/tools';
import { getProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';

const state = vi.hoisted(() => ({ unattended: false, origin: undefined as undefined | { kind: string }, missing: false, fails: false }));
vi.mock('../../../../src/host/permissions/modes', () => ({ getPermissionModeManager: () => ({ isUnattendedSession: () => state.unattended }) }));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({ getSessionManager: () => ({ getSession: async () => {
  if (state.fails) throw new Error('session read failed');
  return state.missing ? null : { origin: state.origin };
} }) }));

beforeEach(() => Object.assign(state, { unattended: false, origin: undefined, missing: false, fails: false }));

async function execute(description: unknown, overrides: Partial<ToolContext> = {}) {
  const emit = vi.fn();
  const handler = await getProtocolRegistry().resolve('schedule_task');
  const result = await handler.execute({ description }, {
    sessionId: 'attended-session', abortSignal: new AbortController().signal, emit, ...overrides,
  } as ToolContext, vi.fn());
  return { result, emit };
}

describe('registered schedule_task module', () => {
  it('emits only a draft request preserving the wording, with no job creation', async () => {
    const description = '每天9点汇总销售表';
    const { result, emit } = await execute(description);
    expect(result.ok).toBe(true);
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: 'schedule_draft_requested', data: { sessionId: 'attended-session', description } });
    expect(result.output).toContain('nothing is created until they confirm');
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
    expect((await execute('weekly summary')).result.ok).toBe(true);
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
