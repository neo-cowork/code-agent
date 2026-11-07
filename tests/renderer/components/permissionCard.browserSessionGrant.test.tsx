// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const state = vi.hoisted(() => ({
  request: null as PermissionRequest | null,
}));
const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: 'session-current',
    setPendingPermissionRequest: vi.fn(),
    dismissPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
    language: 'zh',
    setLanguage: () => {},
    cloudUIStrings: undefined,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: vi.fn() },
}));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { usePermissionStore } from '../../../src/renderer/stores/permissionStore';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

describe('PermissionCard browserSessionGrant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    usePermissionStore.getState().clearSessionMemory();
    usePermissionStore.getState().clearPersistentMemory();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    releaseApprovalResponse('perm-browser-1');
    releaseApprovalResponse('perm-unrelated-cmd');
  });

  it('repro (a) / ⑤: session click on a Browser card writes no permission memory (`command:`), and a later unrelated command card without command text is not auto-approved', async () => {
    state.request = {
      id: 'perm-browser-1',
      sessionId: 'session-current',
      tool: 'Browser',
      type: 'command',
      details: {
        action: 'handle_dialog',
        browserGrantScope: { action: 'handle_dialog', origin: 'https://site-a.example.com' },
      } as PermissionRequest['details'],
      timestamp: 1,
    };

    const { rerender } = render(<PermissionCard />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /本会话允许/ }));
    });

    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
      'perm-browser-1',
      'allow_session',
      'session-current',
    );

    invoke.mockClear();
    state.request = {
      id: 'perm-unrelated-cmd',
      sessionId: 'session-current',
      tool: 'SomeOtherExecTool',
      type: 'command',
      details: {},
      timestamp: 2,
    };
    rerender(<PermissionCard />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect([
      usePermissionStore.getState().memory.session.get('command:'),
      invoke.mock.calls.length,
    ]).toEqual([undefined, 0]);
  });
});
