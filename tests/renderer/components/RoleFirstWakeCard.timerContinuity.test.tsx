// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleFirstWakeSnapshot } from '../../../src/shared/contract/roleAssets';
import { ROLE_FIRST_WAKE_THINKING_TIMER_MAX_AGE_MS } from '../../../src/shared/constants';

const getFirstWake = vi.hoisted(() => vi.fn<(roleId: string) => Promise<RoleFirstWakeSnapshot | null>>());
const listRoles = vi.hoisted(() => vi.fn(async () => []));

vi.mock('../../../src/renderer/services/rolesClient', () => ({
  getFirstWake: (roleId: string) => getFirstWake(roleId),
  listRoles: () => listRoles(),
  consumeFirstWakeSuggestion: async () => ({ success: true }),
  skipFirstWake: async () => ({ success: true }),
  retryFirstWake: async () => ({ retried: true }),
  listWakeProposals: async () => [],
}));

import { RoleFirstWakeCard } from '../../../src/renderer/components/features/chat/RoleFirstWakeCard';

function running(startedAt?: number): RoleFirstWakeSnapshot {
  return {
    state: 'running',
    sourcesMode: 'connected',
    suggestions: [],
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}

function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
}

async function shownText(): Promise<string> {
  return (await screen.findByTestId('thinking-digest')).textContent ?? '';
}

beforeEach(() => {
  getFirstWake.mockReset();
  listRoles.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RoleFirstWakeCard thinking timer', () => {
  it('reload re-imports the card and keeps a 42s startedAt', async () => {
    freezeClock();
    const startedAt = Date.now() - 42_000;
    getFirstWake.mockResolvedValue(running(startedAt));
    vi.resetModules();
    const reloaded = await import('../../../src/renderer/components/features/chat/RoleFirstWakeCard');
    render(<reloaded.RoleFirstWakeCard roleId="role-reload" />);
    expect(await shownText()).toBe('正在思考… · 42s');
  });

  it('startedAt absent renders 正在思考… · 1s', async () => {
    freezeClock();
    getFirstWake.mockResolvedValue(running());
    render(<RoleFirstWakeCard roleId="role-absent" />);
    expect(await shownText()).toBe('正在思考… · 1s');
  });

  it('startedAt in the future renders 正在思考… · 1s', async () => {
    freezeClock();
    getFirstWake.mockResolvedValue(running(Date.now() + 60_000));
    render(<RoleFirstWakeCard roleId="role-future" />);
    expect(await shownText()).toBe('正在思考… · 1s');
  });

  it('startedAt NaN renders 正在思考… · 1s', async () => {
    freezeClock();
    getFirstWake.mockResolvedValue(running(Number.NaN));
    render(<RoleFirstWakeCard roleId="role-nan" />);
    expect(await shownText()).toBe('正在思考… · 1s');
  });

  it('startedAt older than the cap renders 正在思考… · 1s', async () => {
    freezeClock();
    getFirstWake.mockResolvedValue(running(Date.now() - ROLE_FIRST_WAKE_THINKING_TIMER_MAX_AGE_MS - 1_000));
    render(<RoleFirstWakeCard roleId="role-stale" />);
    expect(await shownText()).toBe('正在思考… · 1s');
  });

  it('startedAt exactly at the cap still counts', async () => {
    freezeClock();
    getFirstWake.mockResolvedValue(running(Date.now() - ROLE_FIRST_WAKE_THINKING_TIMER_MAX_AGE_MS));
    render(<RoleFirstWakeCard roleId="role-cap" />);
    expect(await shownText()).toBe('正在思考… · 600s');
  });

  it('optimistic mount time switches to startedAt and does not fall back to 1s', async () => {
    freezeClock();
    const shownAt = Date.now();
    let resolveSnapshot!: (snapshot: RoleFirstWakeSnapshot) => void;
    getFirstWake.mockReturnValue(new Promise((resolve) => { resolveSnapshot = resolve; }));
    render(<RoleFirstWakeCard roleId="role-opt" expectLive />);
    expect(await shownText()).toBe('正在思考… · 1s');
    act(() => { vi.advanceTimersByTime(8_000); });
    expect(screen.getByTestId('thinking-digest').textContent).toBe('正在思考… · 8s');
    await act(async () => {
      resolveSnapshot(running(shownAt + 3_000));
      await Promise.resolve();
    });
    // 入队比卡片晚 3s，现在已过 8s：显示 5s。回退 3s，等于真实排队时间，不会掉回 1s。
    expect(screen.getByTestId('thinking-digest').textContent).toBe('正在思考… · 5s');
  });
});
