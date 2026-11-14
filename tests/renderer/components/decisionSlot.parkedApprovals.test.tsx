// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParkedApprovalInboxItem } from '../../../src/shared/contract/pendingApproval';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const api = vi.hoisted(() => ({ list: vi.fn(), invoke: vi.fn() }));
vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: { listParkedApprovals: api.list },
}));
vi.mock('../../../src/renderer/services/ipcService', () => {
  const ipc = { invoke: api.invoke, on: () => () => {}, isAvailable: () => true };
  return { default: ipc, ipcService: ipc };
});

import { DecisionSlot } from '../../../src/renderer/components/features/chat/DecisionSlot';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { refreshParkedApprovals } from '../../../src/renderer/stores/parkedApprovalStore';
import { hasNeedsInputForSession } from '../../../src/renderer/utils/sessionNeedsInput';
import { useToastStore } from '../../../src/renderer/hooks/useToast';

const SESSION = 'restarted-session';
const row = (changes: Partial<ParkedApprovalInboxItem> = {}): ParkedApprovalInboxItem => ({
  id: 'persisted-request', kind: 'tool_approval', sessionId: SESSION, toolCallId: 'delete-call',
  tool: 'Bash', requestedAt: 1000, status: 'pending', forceConfirm: true,
  argsPreview: 'rm notes/old-export.csv', commandPreview: 'rm notes/old-export.csv', ...changes,
});
const loadSessions = vi.fn(async () => {});
const switchSession = vi.fn(async () => {});

beforeEach(async () => {
  vi.clearAllMocks();
  api.list.mockResolvedValue([]);
  api.invoke.mockResolvedValue({ resumed: 'executed' });
  await refreshParkedApprovals();
  useAppStore.setState({ language: 'zh', pendingPermissionRequest: null, pendingPermissionSessionId: null, queuedPermissionRequests: {} });
  useSessionStore.setState({ currentSessionId: SESSION, messages: [], loadSessions, switchSession });
  useToastStore.setState({ toasts: [] });
});
afterEach(() => cleanup());

async function open(items: ParkedApprovalInboxItem[] = [row()]) {
  api.list.mockResolvedValue(items);
  render(<DecisionSlot />);
  await act(async () => { await refreshParkedApprovals(); });
}

describe('DecisionSlot persisted decisions after restart', () => {
  it('durable waiting label => card rendered with both clickable responses, without memory permission or transcript calls', async () => {
    expect(hasNeedsInputForSession(SESSION, {
      durableWaitingApprovalSessionIds: new Set([SESSION]),
    })).toBe(true);
    await open();
    const card = screen.getByTestId('parked-approval-card');
    expect((within(card).getByRole('button', { name: '允许一次' }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(card).getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(false);
    expect(card.textContent).toContain('rm notes/old-export.csv');
    expect(screen.queryByText('本次任务内允许')).toBeNull();
  });

  it.each(['允许一次', '拒绝'])('responds through existing IPC with the ledger row id: %s', async (name) => {
    await open();
    api.list.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name }));
    await waitFor(() => expect(api.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'persisted-request', name === '拒绝' ? 'deny' : 'allow', SESSION,
    ));
    await waitFor(() => expect(screen.queryByTestId('parked-approval-card')).toBeNull());
    await waitFor(() => expect(loadSessions).toHaveBeenCalledWith({ silent: true }));
    expect(switchSession).toHaveBeenCalledWith(SESSION, { force: true });
  });

  it('shows one card per row including legacy rows without a tool-call id; filters nonpending, other gates and other sessions', async () => {
    await open([
      row(), row({ id: 'legacy', toolCallId: undefined }),
      row({ id: 'void', status: 'voided' }), row({ id: 'orphan', status: 'orphaned' }),
      row({ id: 'foreign', sessionId: 'other' }), row({ id: 'directory', kind: 'directory_access' }),
      row({ id: 'corrupt', tool: '' }),
    ]);
    expect(screen.getAllByTestId('parked-approval-card')).toHaveLength(2);
  });

  it('does not duplicate an in-memory permission card for the same row', async () => {
    useAppStore.setState({
      pendingPermissionRequest: { id: 'persisted-request', tool: 'Bash', type: 'command', details: { command: 'rm notes/old-export.csv' }, timestamp: 1, forceConfirm: true },
      pendingPermissionSessionId: SESSION,
    });
    await open();
    expect(screen.queryByTestId('parked-approval-card')).toBeNull();
    expect(screen.getByTestId('decision-slot')).not.toBeNull();
  });

  it('updates the preview when the ids have not changed', async () => {
    await open();
    api.list.mockResolvedValue([row({ argsPreview: 'rm notes/another-export.csv' })]);
    await act(async () => { await refreshParkedApprovals(); });
    expect(screen.getByTestId('parked-approval-card').textContent).toContain('another-export.csv');
  });

  it('keeps the card retryable after a transport or storage failure, without duplicate clicks', async () => {
    let reject!: (reason: Error) => void;
    api.invoke.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    await open();
    const allow = screen.getByRole('button', { name: '允许一次' });
    fireEvent.click(allow);
    fireEvent.click(allow);
    expect(api.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error('offline')); });
    await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('parked-approval-card')).not.toBeNull();
    api.invoke.mockResolvedValueOnce({ outcome: 'storage_unavailable' });
    fireEvent.click(allow);
    await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));
  });

  it('refreshes after a stale response and removes the card', async () => {
    await open();
    api.invoke.mockResolvedValueOnce({ outcome: 'unknown_request', closed: true });
    api.list.mockResolvedValue([row({ status: 'voided' })]);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() => expect(screen.queryByTestId('parked-approval-card')).toBeNull());
  });

  it('keeps sensitive-step handback semantics instead of offering execution approval', async () => {
    await open([row({ tool: 'computer', sensitiveStep: { kind: 'password', appName: 'Notes' } })]);
    expect((screen.getByRole('button', { name: '完成后继续' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '这步不做了' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: '允许一次' })).toBeNull();
  });

  it('does not navigate back to the answered session after the user switches away', async () => {
    await open();
    loadSessions.mockImplementationOnce(async () => {
      useSessionStore.setState({ currentSessionId: 'another-session' });
    });
    api.list.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    await waitFor(() => expect(loadSessions).toHaveBeenCalled());
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('queues the post-response refresh behind an older in-flight list', async () => {
    await open();
    let finish!: (items: ParkedApprovalInboxItem[]) => void;
    api.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const stalePoll = refreshParkedApprovals();
    api.list.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    await act(async () => { finish([row()]); await stalePoll; });
    await waitFor(() => expect(screen.queryByTestId('parked-approval-card')).toBeNull());
  });
});
