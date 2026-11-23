import { expect, it, vi } from 'vitest';
import { initializeSessionStore, reloadSessionsForAuthChange, useSessionStore } from '../../../src/renderer/stores/sessionStore';

it('does not create a partial new-chat group when principal reload supersedes the initial list', async () => {
  const pending: Array<(value: unknown) => void> = [];
  const invoke = vi.fn(async (_domain, action) => {
    if (action === 'list') return new Promise((resolve) => pending.push(resolve));
    if (action === 'load') return { success: true, data: { id: 'weekly-report', title: 'Weekly report', messages: [], todos: [] } };
    if (action === 'create') return { success: true, data: { id: 'fresh-chat', title: '新对话', messageCount: 0, turnCount: 0, createdAt: 3, updatedAt: 3 } };
    return { success: true, data: [] };
  });
  (globalThis as Record<string, unknown>).window = { domainAPI: { invoke }, electronAPI: { on: vi.fn(() => () => {}) } };
  const boot = initializeSessionStore();
  expect(pending).toHaveLength(1);
  const reload = reloadSessionsForAuthChange({ principalChanged: true });
  expect(pending).toHaveLength(2);
  pending[0]({ success: true, data: [] });
  await boot;
  expect(invoke.mock.calls.some(([, action]) => action === 'create')).toBe(false);
  pending[1]({ success: true, data: [{ id: 'weekly-report', title: 'Weekly report', messageCount: 2, turnCount: 1, createdAt: 1, updatedAt: 2 }] });
  await reload;
  expect(useSessionStore.getState().sessions.map((session) => session.id)).toContain('weekly-report');
  // No browser-local reason to reopen weekly-report: the start page (one new session) opens instead.
  expect(useSessionStore.getState().currentSessionId).toBe('fresh-chat');
  expect(invoke.mock.calls.filter(([, action]) => action === 'create')).toHaveLength(1);
});
