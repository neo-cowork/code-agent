// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ invoke: vi.fn(), terminal: false }));
vi.mock('../../../src/renderer/stores/swarmStore', () => ({
  useSwarmStore: (select: (state: object) => unknown) => select({ activeSessionId: null, activeRunId: null, activeTreeId: null, lastEventAt: 0 }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invoke: calls.invoke } }));
import { useDurableSwarmRunDetail } from '../../../src/renderer/hooks/useDurableSwarmRunDetail';

afterEach(() => { cleanup(); vi.useRealTimers(); calls.invoke.mockReset(); });
describe('durable member terminal refresh without an active stream', () => {
  it('keeps polling after parent failure until the persisted child has really ended', async () => {
    vi.useFakeTimers(); calls.terminal = false;
    calls.invoke.mockImplementation(async (channel: string) => channel.includes('list')
      ? [{ id: 'trace' }]
      : { run: { id: 'trace', sessionId: 'session', status: calls.terminal ? 'completed' : 'running' }, agents: [{ agentId: 'child', status: calls.terminal ? 'completed' : 'running' }] });
    const hook = renderHook(() => useDurableSwarmRunDetail('session'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(hook.result.current?.agents[0].status).toBe('running');
    calls.terminal = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(hook.result.current?.agents[0].status).toBe('completed');
  });
});
