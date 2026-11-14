// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const state = vi.hoisted(() => ({ request: null as PermissionRequest | null, language: 'zh' as 'zh' | 'en' }));
const invoke = vi.hoisted(() => vi.fn());
const invokeDomain = vi.hoisted(() => vi.fn());
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
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { isAvailable: () => true, invoke, invokeDomain } }));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import PermissionGrantList from '../../../src/renderer/components/features/settings/tabs/PermissionGrantList';
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
    ['zh', '本次任务内允许', '24 小时内允许', '本会话允许', '始终允许'],
    ['en', 'Allow for this task', 'Allow for 24 hours', 'Allow for session', 'Always allow'],
  ] as const)('shows both expiring tiers and removes generic legacy labels (%s)', (language, run, day, session, always) => {
    state.language = language;
    render(<PermissionCard />);
    expect(screen.getByRole('button', { name: new RegExp(run) })).toBeTruthy();
    expect(screen.getByRole('button', { name: new RegExp(day) })).toBeTruthy();
    expect(screen.queryByRole('button', { name: new RegExp(session) })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(always) })).toBeNull();
  });

  it.each([
    ['zh', 'run', '本次任务内允许', '本次任务', '限时放行'],
    ['zh', '24h', '24 小时内允许', '24 小时内', '限时放行'],
    ['en', 'run', 'Allow for this task', 'This task', 'Temporary allow'],
    ['en', '24h', 'Allow for 24 hours', '24 hours', 'Temporary allow'],
  ] as const)('card/list scope and row prefix agree (%s, %s)', async (language, source, button, scope, prefix) => {
    state.language = language;
    invokeDomain.mockResolvedValue([{
      id: `grant-${source}`, kind: 'tool-timed', label: 'Write', source,
      grantedAt: Date.now(), expiresAt: source === 'run' ? null : Date.now() + 86_400_000,
    }]);
    render(<><PermissionCard /><PermissionGrantList /></>);
    const cardButton = screen.getByRole('button', { name: new RegExp(button) });
    const row = await screen.findByTestId('permission-grant-row');
    const metadata = row.querySelector('.text-zinc-500')?.textContent;
    expect(metadata).toBeTruthy();
    expect(metadata).toContain(scope);
    // The button adds an action verb; the list keeps the shared scope noun phrase.
    expect(cardButton.textContent?.toLocaleLowerCase(language)).toContain(scope.toLocaleLowerCase(language));
    expect(metadata).toMatch(new RegExp(`^${source === 'run' ? scope : `${prefix} · ${scope}`} · `));
    if (source === 'run') {
      expect(row.textContent).not.toMatch(/限时放行|Temporary allow|Time-boxed allow/);
    } else {
      expect(row.textContent).toContain(prefix);
    }
    expect(invokeDomain).toHaveBeenCalledWith('domain:settings', 'listPermissionGrants');
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
    ['allow_run', '本次任务内允许'], ['allow_24h', '24 小时内允许'],
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
    expect(screen.queryByRole('button', { name: /本次任务内允许|24 小时内允许/ })).toBeNull();
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

  it.each([
    ['zh', 'read', '允许读取 飞书？', '飞书的所有只读工具', '用途：每周日程汇总'],
    ['zh', 'write', '允许写入 飞书？', '仅这个写入操作', '用途：每周日程汇总'],
    ['en', 'read', 'Allow reading 飞书?', 'All read-only tools in 飞书', 'Purpose: 每周日程汇总'],
    ['en', 'write', 'Allow writing to 飞书?', 'Only this write operation', 'Purpose: 每周日程汇总'],
  ] as const)('connector card names access, tier scope and host purpose (%s/%s)', (language, access, title, scope, purpose) => {
    state.language = language;
    state.request = { ...request, type: 'mcp', tool: 'mcp__lark__calendar_v4_calendar_primary', details: {
      connectorAccess: { connectorId: 'lark', connectorName: '飞书', access }, purpose: '每周日程汇总',
      preview: { type: 'generic', summary: '执行工具 mcp__lark__calendar_v4_calendar_primary' },
    } };
    render(<PermissionCard />);
    expect(screen.getAllByText(title)).toHaveLength(2);
    expect(screen.getAllByText(new RegExp(scope))).toHaveLength(2);
    expect(screen.getByTestId('connector-purpose').textContent).toBe(purpose);
    expect(screen.queryByText('执行工具 mcp__lark__calendar_v4_calendar_primary')).toBeNull();
  });

  it('omits unknown purpose and ignores legacy renderer allow memory for classified connector cards', () => {
    state.request = { ...request, type: 'mcp', tool: 'mcp__lark__calendar_v4_calendar_primary', details: {
      server: 'lark', toolName: 'calendar_v4_calendar_primary',
      connectorAccess: { connectorId: 'lark', connectorName: '飞书', access: 'read' },
    } };
    usePermissionStore.setState({ memory: { session: new Map([['mcp:lark/calendar_v4_calendar_primary', 'allow']]), persistent: {} } });
    render(<PermissionCard />);
    expect(screen.queryByTestId('connector-purpose')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

});
