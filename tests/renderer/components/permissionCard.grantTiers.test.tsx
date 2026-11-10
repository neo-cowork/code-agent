// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const state = vi.hoisted(() => ({ request: null as PermissionRequest | null, language: 'zh' as 'zh' | 'en' }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: state.language === 'zh' ? zh : en, language: state.language }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request, pendingPermissionSessionId: 'session-current',
    setPendingPermissionRequest: vi.fn(), recordPermissionDecision: vi.fn(),
    language: state.language, setLanguage: vi.fn(), cloudUIStrings: undefined,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { isAvailable: () => true, invoke } }));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { usePermissionStore } from '../../../src/renderer/stores/permissionStore';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

const originalSaveMemory = usePermissionStore.getState().saveMemory;
const saveMemory = vi.fn(originalSaveMemory);
const request: PermissionRequest = {
  id: 'permission-tier', sessionId: 'session-current', tool: 'Write', type: 'file_write',
  details: { path: '/tmp/weekly-report/summary.md' }, timestamp: 1,
};

describe('PermissionCard grant tiers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue({ success: true });
    state.language = 'zh';
    state.request = request;
    usePermissionStore.setState({ memory: { session: new Map(), persistent: {} }, saveMemory });
  });
  afterEach(() => {
    cleanup();
    releaseApprovalResponse(request.id);
    usePermissionStore.setState({ memory: { session: new Map(), persistent: {} }, saveMemory: originalSaveMemory });
    localStorage.clear();
  });

  it.each([
    ['zh', '到这次做完为止', '24 小时内允许', '本会话允许', '始终允许'],
    ['en', 'Until this task is done', 'Allow for 24 hours', 'Allow for session', 'Always allow'],
  ] as const)('shows both expiring tiers and removes generic legacy labels (%s)', (language, run, day, session, always) => {
    state.language = language;
    render(<PermissionCard />);
    expect(screen.getByRole('button', { name: new RegExp(run) })).toBeTruthy();
    expect(screen.getByRole('button', { name: new RegExp(day) })).toBeTruthy();
    expect(screen.queryByRole('button', { name: new RegExp(session) })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(always) })).toBeNull();
  });

  it.each([
    ['s', 'allow_run'], ['a', 'allow_24h'],
  ] as const)('shortcut %s sends exactly %s without renderer memory', async (key, response) => {
    render(<PermissionCard />);
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent.keyDown(window, { key });
    await waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, request.id, response, request.sessionId));
    expect(saveMemory).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });

  it.each([
    ['allow_run', '到这次做完为止'], ['allow_24h', '24 小时内允许'],
  ] as const)('click sends %s directly without renderer memory', async (response, label) => {
    render(<PermissionCard />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }));
    await waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, request.id, response, request.sessionId));
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it.each([
    ['forceConfirm', { forceConfirm: true }],
    ['danger', { type: 'dangerous_command', dangerLevel: 'danger' }],
    ['editable', { tool: 'mail_send', details: { to: ['team@example.test'], subject: 'Weekly report', body: 'Ready for review' } }],
    ['sandbox-escalation', { details: { action: 'sandbox_escalate_once', deniedPath: '/tmp/report.md' } }],
  ] as const)('hides both tiers and ignores their shortcuts for %s', (_name, overrides) => {
    state.request = { ...request, ...overrides } as PermissionRequest;
    render(<PermissionCard />);
    expect(screen.queryByRole('button', { name: /到这次做完为止|24 小时内允许/ })).toBeNull();
    fireEvent.keyDown(window, { key: 's' });
    fireEvent.keyDown(window, { key: 'a' });
    expect(invoke).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it.each(['session', 'always'] as const)('a seeded legacy %s memory still auto-approves', async (level) => {
    if (level === 'session') {
      usePermissionStore.setState({ memory: { session: new Map([['file_write:/tmp/weekly-report', 'allow']]), persistent: {} } });
    } else {
      localStorage.setItem('permission-memory', JSON.stringify({ state: { memory: { persistent: { 'file_write:/tmp/weekly-report': 'allow' } } }, version: 0 }));
      await usePermissionStore.persist.rehydrate();
    }
    render(<PermissionCard />);
    await waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, request.id, level === 'session' ? 'allow_session' : 'allow', request.sessionId));
  });
});
