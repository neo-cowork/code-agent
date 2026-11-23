// @vitest-environment jsdom
// 首次醒来卡内的「等你批准」行：后台醒来会话停车等批准时，用户只会看见这张卡。
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleFirstWakeSnapshot } from '../../../src/shared/contract/roleAssets';

const getFirstWake = vi.fn<(roleId: string) => Promise<RoleFirstWakeSnapshot | null>>();
const invoke = vi.fn();
const invokeDomain = vi.fn();

vi.mock('../../../src/renderer/services/rolesClient', () => ({
  getFirstWake: (roleId: string) => getFirstWake(roleId),
  consumeFirstWakeSuggestion: vi.fn(),
  skipFirstWake: vi.fn(),
  retryFirstWake: vi.fn(),
  listRoles: () => Promise.resolve([]),
  listWakeProposals: () => Promise.resolve([]),
}));
vi.mock('../../../src/renderer/utils/inviteExpert', () => ({ goToExpertThread: vi.fn() }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: () => () => {},
    invoke: (...args: unknown[]) => invoke(...args),
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
  },
}));

import { RoleFirstWakeCard } from '../../../src/renderer/components/features/chat/RoleFirstWakeCard';
import { useToastStore } from '../../../src/renderer/hooks/useToast';

const RUNNING: RoleFirstWakeSnapshot = {
  state: 'running',
  sessionId: 'fw-session',
  sourcesMode: 'connected',
  sources: ['Calendar'],
  suggestions: [],
};

function parkedRow(sessionId: string) {
  return { id: 'perm-1', sessionId, status: 'pending', tool: 'calendar', argsPreview: '', requestedAt: 1 };
}

describe('RoleFirstWakeCard 内的待批准行', () => {
  let parked: ReturnType<typeof parkedRow>[];

  beforeEach(() => {
    parked = [];
    getFirstWake.mockReset().mockImplementation(async () => RUNNING);
    invoke.mockReset().mockResolvedValue({ requestId: 'perm-1', sessionId: 'fw-session', source: 'web' });
    invokeDomain.mockReset().mockImplementation(async () => parked);
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => { cleanup(); });

  it('本会话有 pending 审批 → 思考行换成「等你确认：<动作>」+ 允许/拒绝；别的会话的审批不算', async () => {
    parked = [parkedRow('other-session')];
    render(<RoleFirstWakeCard roleId="r1" expectLive />);
    await waitFor(() => expect(getFirstWake).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('role-first-wake-approval')).toBeNull();

    cleanup();
    parked = [parkedRow('fw-session')];
    render(<RoleFirstWakeCard roleId="r1" expectLive />);
    const row = await screen.findByTestId('role-first-wake-approval');
    expect(row.textContent).toMatch(/^等你确认：/);
    expect(row.textContent).not.toMatch(/calendar/);
    expect(screen.getByTestId('role-first-wake-approve').textContent).toBe('允许');
    expect(screen.getByTestId('role-first-wake-deny').textContent).toBe('拒绝');
    expect(screen.getByText('先不用')).toBeTruthy();
  });

  it('点允许 → AGENT_PERMISSION_RESPONSE(id, allow, sessionId)，行回到思考态', async () => {
    parked = [parkedRow('fw-session')];
    render(<RoleFirstWakeCard roleId="r1" expectLive />);
    fireEvent.click(await screen.findByTestId('role-first-wake-approve'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agent:permission-response', 'perm-1', 'allow', 'fw-session'));
    parked = [];
    await waitFor(() => expect(screen.queryByTestId('role-first-wake-approval')).toBeNull());
  });

  it('点拒绝 → 送 deny', async () => {
    parked = [parkedRow('fw-session')];
    render(<RoleFirstWakeCard roleId="r1" expectLive />);
    fireEvent.click(await screen.findByTestId('role-first-wake-deny'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agent:permission-response', 'perm-1', 'deny', 'fw-session'));
  });

  it('审批已失效 → toast 提示，不装作成功', async () => {
    parked = [parkedRow('fw-session')];
    invoke.mockResolvedValue({ outcome: 'unknown_request' });
    render(<RoleFirstWakeCard roleId="r1" expectLive />);
    fireEvent.click(await screen.findByTestId('role-first-wake-approve'));
    await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
    expect(useToastStore.getState().toasts[0].message).toContain('失效');
  });

  it('发送失败 → 报错 toast', async () => {
    parked = [parkedRow('fw-session')];
    invoke.mockRejectedValue(new Error('ipc down'));
    render(<RoleFirstWakeCard roleId="r1" expectLive />);
    fireEvent.click(await screen.findByTestId('role-first-wake-approve'));
    await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
    expect(useToastStore.getState().toasts[0].type).toBe('error');
  });
});
