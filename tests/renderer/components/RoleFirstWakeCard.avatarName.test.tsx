// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleFirstWakeSnapshot, RolePanelEntry } from '../../../src/shared/contract/roleAssets';
import { RoleFirstWakeCard, RoleFirstWakeThreadBanner } from '../../../src/renderer/components/features/chat/RoleFirstWakeCard';
import { RoleDraftNotifications } from '../../../src/renderer/components/features/chat/ChatInput/RoleDraftCard';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const getFirstWake = vi.fn<(roleId: string) => Promise<RoleFirstWakeSnapshot | null>>();
const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const listeners = new Map<string, (event: unknown) => void>();

vi.mock('../../../src/renderer/services/rolesClient', () => ({
  getFirstWake: (roleId: string) => getFirstWake(roleId),
  listRoles: () => listRoles(),
  consumeFirstWakeSuggestion: vi.fn(),
  skipFirstWake: vi.fn(),
  retryFirstWake: vi.fn(),
  listWakeProposals: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/renderer/utils/inviteExpert', () => ({ goToExpertThread: vi.fn() }));
vi.mock('../../../src/renderer/utils/startEditRoleChat', () => ({ startEditRoleChat: vi.fn() }));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (channel: string, callback: (event: unknown) => void) => {
      listeners.set(channel, callback);
      return () => { listeners.delete(channel); };
    },
    invokeDomain: vi.fn().mockResolvedValue([]),
  },
}));

const schedule = '日程助理';
const weekly = '周会提醒助理';
const composerSessionId = 'composer';

function entry(roleId: string): RolePanelEntry {
  return { roleId, description: '', source: 'user', memoryCount: 0, lastWork: null };
}

function wakeSession(id: string, roleId: string): SessionWithMeta {
  return {
    id,
    title: `${roleId} · 初次见面`,
    origin: { kind: 'cron', metadata: { trigger: 'first_wake', roleId } },
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
  };
}

function emitCreatedDirect(roleId: string) {
  act(() => {
    listeners.get('agent:event')?.({
      type: 'role_created_direct',
      data: {
        sessionId: composerSessionId,
        roleId,
        displayName: roleId,
        canDo: '提醒会议冲突',
        willNotDo: '修改日历',
      },
    });
  });
}

function deferNames() {
  const deferred = Promise.withResolvers<RolePanelEntry[]>();
  listRoles.mockReturnValueOnce(deferred.promise);
  return deferred.resolve;
}

describe('RoleFirstWakeCard avatar name', () => {
  beforeEach(() => {
    getFirstWake.mockReset().mockResolvedValue({ state: 'completed', sourcesMode: 'none', suggestions: [] });
    listRoles.mockReset().mockResolvedValue([entry(schedule), entry(weekly)]);
    useSessionStore.setState({ currentSessionId: composerSessionId, messages: [], sessions: [] });
    sessionStorage.clear();
  });

  afterEach(cleanup);

  it('drops the previous initial when the banner switches first-wake sessions', async () => {
    const first = wakeSession('first', schedule);
    const second = wakeSession('second', weekly);
    useSessionStore.setState({ currentSessionId: first.id, sessions: [first, second] });
    render(<RoleFirstWakeThreadBanner />);

    expect((await screen.findByRole('img', { name: schedule })).textContent).toBe('日');
    const resolveNames = deferNames();
    act(() => useSessionStore.setState({ currentSessionId: second.id }));

    // The banner waits for its new snapshot, so no avatar is visible in the first render.
    expect(screen.queryByRole('img', { name: schedule })).toBeNull();
    expect((await screen.findByRole('img', { name: weekly })).textContent).toBe('·');
    resolveNames([entry(schedule), entry(weekly)]);
    await waitFor(() => expect(screen.getByRole('img', { name: weekly }).textContent).toBe(second.title.charAt(0)));
  });

  it('drops the previous initial for two direct creations in the same composer', async () => {
    render(<RoleDraftNotifications />);
    emitCreatedDirect(schedule);
    await waitFor(() => expect(screen.getByRole('img', { name: schedule }).textContent).toBe('日'));

    const resolveNames = deferNames();
    emitCreatedDirect(weekly);

    expect(screen.getByRole('img', { name: weekly }).textContent).toBe('·');
    resolveNames([entry(schedule), entry(weekly)]);
    await waitFor(() => expect(screen.getByRole('img', { name: weekly }).textContent).toBe('周'));
  });

  it('shows a placeholder until the display name resolves', async () => {
    const resolveNames = deferNames();
    render(<RoleFirstWakeCard roleId="role-1" expectLive />);

    const avatar = screen.getByRole('img', { name: 'role-1' });
    expect(avatar.textContent).toBe('·');
    expect(avatar.title).toBe('role-1');

    resolveNames([{ ...entry('role-1'), displayName: '小满' }]);
    const resolvedAvatar = await screen.findByRole('img', { name: '小满' });
    expect(resolvedAvatar.textContent).toBe('小');
    expect(resolvedAvatar.title).toBe('小满');
  });

  it.each(['empty list', 'rejection'])('uses the title fallback after %s', async (outcome) => {
    if (outcome === 'empty list') {
      listRoles.mockResolvedValueOnce([]);
    } else {
      listRoles.mockRejectedValueOnce(new Error('List unavailable'));
    }

    render(<RoleFirstWakeCard roleId={weekly} expectLive />);
    const avatar = screen.getByRole('img', { name: weekly });
    expect(avatar.textContent).toBe('·');
    await waitFor(() => expect(avatar.textContent).toBe('周'));
  });
});
