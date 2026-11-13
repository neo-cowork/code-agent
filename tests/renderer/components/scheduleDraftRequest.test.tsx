// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useScheduleDraftRequest } from '../../../src/renderer/components/features/chat/ChatInput/useScheduleDraftRequest';

const bus = vi.hoisted(() => ({ listener: undefined as undefined | ((event: { type: string; data: unknown }) => void), off: vi.fn() }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ ipcService: { on: (_: string, listener: typeof bus.listener) => { bus.listener = listener; return bus.off; } } }));
const event = (sessionId = 's1', description = '每天9点汇总销售表') => ({ type: 'schedule_draft_requested', data: { sessionId, description } });
beforeEach(() => { bus.listener = undefined; bus.off.mockClear(); });

describe('model schedule draft event subscriber', () => {
  it('runs the shared creation pipeline only for the active session and unsubscribes', async () => {
    const run = vi.fn().mockResolvedValue(true);
    const { unmount } = renderHook(() => useScheduleDraftRequest('s1', false, run));
    await act(async () => { bus.listener?.(event('other')); bus.listener?.(event()); });
    expect(run).toHaveBeenCalledExactlyOnceWith('每天9点汇总销售表');
    unmount();
    expect(bus.off).toHaveBeenCalledOnce();
  });
  it('ignores an in-flight creation, including same-tick duplicate events', async () => {
    let finish!: (value: boolean) => void;
    const run = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { rerender } = renderHook(({ creating }) => useScheduleDraftRequest('s1', creating, run), { initialProps: { creating: true } });
    act(() => bus.listener?.(event()));
    expect(run).not.toHaveBeenCalled();
    rerender({ creating: false });
    act(() => { bus.listener?.(event()); bus.listener?.(event()); });
    expect(run).toHaveBeenCalledOnce();
    await act(async () => finish(true));
    act(() => bus.listener?.(event()));
    expect(run).toHaveBeenCalledTimes(2);
    await act(async () => finish(false));
  });
  it('uses the latest active session and rejects malformed events', () => {
    const run = vi.fn().mockResolvedValue(false);
    const { rerender } = renderHook(({ sessionId }) => useScheduleDraftRequest(sessionId, false, run), { initialProps: { sessionId: 's1' } });
    rerender({ sessionId: 's2' });
    act(() => {
      bus.listener?.(event());
      bus.listener?.({ type: 'other', data: event('s2').data });
      bus.listener?.({ type: 'schedule_draft_requested', data: null });
      bus.listener?.(event('s2', ''));
    });
    expect(run).not.toHaveBeenCalled();
  });
});
