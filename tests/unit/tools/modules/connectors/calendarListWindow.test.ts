import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../../src/host/protocol/tools';
import { getConnectorRegistry } from '../../../../../src/host/connectors';
import { calendarModule } from '../../../../../src/host/tools/modules/connectors/calendar';

vi.hoisted(() => { process.env.TZ = 'America/Los_Angeles'; });

const registry = getConnectorRegistry();
const execute = vi.fn().mockResolvedValue({ data: [] });
const permit = vi.fn().mockResolvedValue({ allow: true });
const ctx = {
  sessionId: 'calendar-list-window', workingDir: process.cwd(),
  abortSignal: new AbortController().signal,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, emit: vi.fn(),
} as unknown as ToolContext;

async function run(args: Record<string, unknown>) {
  const handler = await calendarModule.createHandler();
  return handler.execute({ action: 'list_events', ...args }, ctx, permit);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T18:00:00Z'));
  execute.mockClear();
  permit.mockClear();
  registry.unregister('calendar');
  registry.register({
    id: 'calendar', label: 'Calendar', capabilities: ['list_events'], execute,
    getStatus: async () => ({ connected: true, readiness: 'ready', capabilities: ['list_events'] }),
  });
});
afterEach(() => { registry.unregister('calendar'); vi.useRealTimers(); });

describe('calendar list window through the production handler', () => {
  it('(a) converts local strings into the exact connector payload', async () => {
    expect((await run({ from_local: '2026-11-17 13:00', to_local: '2026-11-17 18:00' })).ok).toBe(true);
    const payload = { action: 'list_events', from_ms: Date.parse('2026-11-17T21:00:00Z'), to_ms: Date.parse('2026-11-18T02:00:00Z') };
    expect(execute).toHaveBeenCalledExactlyOnceWith('list_events', payload);
    expect(permit).toHaveBeenCalledWith('calendar', payload);
  });
  it('(b) preserves a cross-day window', async () => {
    await run({ from_local: '2026-11-17 23:30', to_local: '2026-11-18 01:00' });
    expect(execute).toHaveBeenCalledExactlyOnceWith('list_events', { action: 'list_events', from_ms: Date.parse('2026-11-18T07:30:00Z'), to_ms: Date.parse('2026-11-18T09:00:00Z') });
  });
  it('(c) interprets a date from another timezone in the host zone, including DST', async () => {
    // Shanghai 2026-03-09 01:00 is LA 2026-03-08 10:00; input is always host-local.
    await run({ from_local: '2026-03-08 10:00', to_local: '2026-03-08 11:00' });
    expect(execute).toHaveBeenCalledExactlyOnceWith('list_events', { action: 'list_events', from_ms: Date.parse('2026-03-09T01:00:00+08:00'), to_ms: Date.parse('2026-03-09T02:00:00+08:00') });
  });
  it('(d) forwards legacy ms unchanged', async () => {
    const args = { from_ms: 123, to_ms: 456, calendar: 'Work', limit: 4 };
    await run(args);
    expect(execute).toHaveBeenCalledExactlyOnceWith('list_events', { action: 'list_events', ...args });
  });
  it('(e) gives each local bound priority over ms', async () => {
    await run({ from_local: '2026-11-17 13:00', to_local: '2026-11-17 18:00', from_ms: 999, to_ms: 1 });
    expect(execute).toHaveBeenCalledExactlyOnceWith('list_events', { action: 'list_events', from_ms: Date.parse('2026-11-17T21:00:00Z'), to_ms: Date.parse('2026-11-18T02:00:00Z') });
  });
  it.each(['tomorrow', '2026-02-30 09:00', '2026-03-08 02:30', '2026-11-17T09:00Z', null])('(f) rejects bad local input %s before permission or dispatch', async (from_local) => {
    expect(await run({ from_local })).toEqual({ ok: false, code: 'INVALID_ARGS', error: 'from_local must be a real local time written as YYYY-MM-DD HH:mm, for example 2026-11-17 09:00.' });
    expect(execute).not.toHaveBeenCalled();
    expect(permit).not.toHaveBeenCalled();
  });
  it('rejects an invalid to_local even when ms is valid', async () => {
    expect(await run({ to_local: 'bad', to_ms: Date.now() })).toMatchObject({ ok: false, code: 'INVALID_ARGS', error: expect.stringContaining('to_local must be a real local time written as YYYY-MM-DD HH:mm') });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    { from_local: '2026-11-18 09:00', to_local: '2026-11-17 09:00' },
    { from_ms: 456, to_ms: 123 },
    { to_local: '2026-11-15 09:00' },
    { from_local: '2026-11-18 09:00', to_ms: 123 },
  ])('(g) rejects reversed explicit bounds %j', async (args) => {
    expect(await run(args)).toEqual({ ok: false, code: 'INVALID_ARGS', error: 'The to bound must not be earlier than the from bound.' });
    expect(execute).not.toHaveBeenCalled();
    expect(permit).not.toHaveBeenCalled();
  });
  it.each([{ from_local: '2027-11-17 09:00' }, { from_ms: Date.parse('2027-11-17T17:00:00Z') }])('(h) starts a future-only window at from %j', async (args) => {
    await run(args);
    expect(execute).toHaveBeenCalledExactlyOnceWith('list_events', { action: 'list_events', from_ms: Date.parse('2027-11-17T17:00:00Z'), to_ms: Date.parse('2027-12-01T17:00:00Z') });
  });
  it.each([{ from_ms: NaN }, { to_ms: Infinity }, { from_ms: '123' }])('rejects invalid legacy input %j without defaults', async (args) => {
    expect(await run(args)).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('leaves omitted bounds to existing native defaults', async () => {
    await run({});
    expect(execute).toHaveBeenCalledExactlyOnceWith('list_events', { action: 'list_events' });
  });
  it('keeps the normal default end and equal-bound clamp', async () => {
    await run({ from_local: '2026-11-17 09:00' });
    expect(execute).toHaveBeenLastCalledWith('list_events', { action: 'list_events', from_ms: Date.parse('2026-11-17T17:00:00Z') });
    await run({ from_ms: 123, to_ms: 123 });
    expect(execute).toHaveBeenLastCalledWith('list_events', { action: 'list_events', from_ms: 123, to_ms: 123 });
  });
});
