// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';

const state = vi.hoisted(() => ({
  request: null as PermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));
const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: state.language === 'zh' ? zh : en, language: state.language }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: 'session-current',
    setPendingPermissionRequest: vi.fn(),
    dismissPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
    language: state.language,
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
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

function makeRequest(overrides: Partial<PermissionRequest> & { details: PermissionRequest['details'] }): PermissionRequest {
  return {
    id: 'perm-cross-1',
    sessionId: 'session-current',
    tool: 'Browser',
    type: 'command',
    timestamp: 1,
    ...overrides,
  };
}

describe('PermissionCard browser cross-site reason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    state.language = 'zh';
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    releaseApprovalResponse('perm-cross-1');
  });

  it('renders cross-site reason in zh when browserGrantScope and browserCrossSiteOrigins are set', async () => {
    state.request = makeRequest({
      details: {
        action: 'wait_for_download',
        browserGrantScope: { action: 'wait_for_download', origin: 'https://files.vendor-b.example.org' },
        browserCrossSiteOrigins: ['https://reports.finance-a.example.com'],
      } as PermissionRequest['details'],
      reason: '本会话此前仅允许在 https://reports.finance-a.example.com 执行 wait_for_download，当前站点为 https://files.vendor-b.example.org，需重新确认',
    });

    render(<PermissionCard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const notice = screen.getByTestId('permission-browser-cross-site');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain('reports.finance-a.example.com');
    expect(notice.textContent).toContain('files.vendor-b.example.org');
    // zh copy must not contain raw action name
    expect(notice.textContent).not.toContain('wait_for_download');
  });

  it('renders cross-site reason in en', async () => {
    state.language = 'en';
    state.request = makeRequest({
      details: {
        action: 'wait_for_download',
        browserGrantScope: { action: 'wait_for_download', origin: 'https://files.vendor-b.example.org' },
        browserCrossSiteOrigins: ['https://reports.finance-a.example.com'],
      } as PermissionRequest['details'],
      reason: 'cross-site reason',
    });

    render(<PermissionCard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const notice = screen.getByTestId('permission-browser-cross-site');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain('reports.finance-a.example.com');
    expect(notice.textContent).toContain('files.vendor-b.example.org');
    expect(notice.textContent).not.toContain('wait_for_download');
  });

  it('does not render cross-site notice when browserCrossSiteOrigins is absent', async () => {
    state.request = makeRequest({
      details: {
        action: 'wait_for_download',
        browserGrantScope: { action: 'wait_for_download', origin: 'https://files.vendor-b.example.org' },
      } as PermissionRequest['details'],
    });

    render(<PermissionCard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.queryByTestId('permission-browser-cross-site')).toBeNull();
  });

  it('does not render cross-site notice when browserGrantScope is absent', async () => {
    state.request = makeRequest({
      details: {
        action: 'wait_for_download',
        browserCrossSiteOrigins: ['https://reports.finance-a.example.com'],
      } as PermissionRequest['details'],
    });

    render(<PermissionCard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.queryByTestId('permission-browser-cross-site')).toBeNull();
  });

  it('renders multiple previously-allowed origins', async () => {
    state.request = makeRequest({
      details: {
        action: 'handle_dialog',
        browserGrantScope: { action: 'handle_dialog', origin: 'https://site-c.example.com' },
        browserCrossSiteOrigins: ['https://site-a.example.com', 'https://site-b.example.com'],
      } as PermissionRequest['details'],
    });

    render(<PermissionCard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const notice = screen.getByTestId('permission-browser-cross-site');
    expect(notice.textContent).toContain('site-a.example.com');
    expect(notice.textContent).toContain('site-b.example.com');
    expect(notice.textContent).toContain('site-c.example.com');
  });
});
