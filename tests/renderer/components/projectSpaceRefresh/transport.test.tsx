// @vitest-environment jsdom
import React, { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectWithActivity } from '../../../../src/shared/contract/project';
import { IPC_DOMAINS } from '../../../../src/shared/ipc';
import { ProjectListView, type ProjectListViewHandle } from '../../../../src/renderer/components/features/projectSpace/ProjectListView';
import ipcService from '../../../../src/renderer/services/ipcService';
import { useAppStore } from '../../../../src/renderer/stores/appStore';

const existing: ProjectWithActivity = {
  id: 'space-existing', name: 'Existing space', workspacePath: '/tmp/existing-space',
  workspaceKey: 'existing-key', status: 'active', createdAt: 1, updatedAt: 1,
  spacePromotedAt: 1, activeTopicCount: 0, lastActivityAt: null,
};
const created: ProjectWithActivity = {
  ...existing, id: 'space-new', name: 'New space', workspacePath: '/tmp/new-space',
};
const candidate: ProjectWithActivity = { ...created, spacePromotedAt: null };
const ok = (data: unknown) => ({ success: true, data });
const invoke = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  invoke.mockReset();
  window.codeAgentDomainAPI = { invoke } as typeof window.codeAgentDomainAPI;
  useAppStore.setState({ language: 'en', cloudUIStrings: null });
});
afterEach(() => {
  cleanup();
  delete window.codeAgentDomainAPI;
});

function openCreate() {
  const ref = createRef<ProjectListViewHandle>();
  const onSelect = vi.fn();
  const view = render(<ProjectListView ref={ref} onSelect={onSelect} />);
  act(() => ref.current?.openCreate());
  fireEvent.change(screen.getByTestId('project-space-create-name'), { target: { value: created.name } });
  return { ...view, onSelect };
}

// Only domainApi().invoke is faked: ProjectListView -> projectClient ->
// ipcService's read dedupe and error envelope handling all run for real.
describe('space creation through the real domain IPC client', () => {
  it.each(['directory', 'promote', 'trust'] as const)(
    '%s: refreshes without remounting while the pre-create list is still in flight',
    async (source) => {
      const oldRead = deferred<ReturnType<typeof ok>>();
      let reads = 0;
      let saved = false;
      invoke.mockImplementation(async (domain: string, action: string, payload?: Record<string, unknown>) => {
        if (domain === IPC_DOMAINS.FOLDER_TRUST) return ok({
          state: 'untrusted', blockedItems: [], identityChanged: false,
          dangerousItems: source === 'trust' ? [{
            kind: 'project-hooks', displayPath: '.code-agent/hooks/hooks.json', risk: 'execution', gated: true,
          }] : [],
        });
        if (action === 'listWithActivity') {
          if (!payload?.spacesOnly) return ok([existing, candidate]);
          reads += 1;
          return reads === 1 ? oldRead.promise : ok(saved ? [existing, created] : [existing]);
        }
        if (action === 'createSpace' || action === 'promoteToSpace') {
          saved = true;
          return ok(created);
        }
        throw new Error(`Unexpected action: ${domain}:${action}`);
      });
      const { container, onSelect } = openCreate();
      const mountedRoot = container.firstChild;
      if (source === 'promote') {
        fireEvent.click(screen.getByTestId('project-space-create-source-promote'));
        await waitFor(() => expect(screen.getByRole('option', { name: created.name })).toBeTruthy());
        fireEvent.change(screen.getByTestId('project-space-create-promote-select'), { target: { value: created.id } });
      } else {
        fireEvent.change(screen.getByTestId('project-space-create-workspace'), { target: { value: created.workspacePath } });
      }
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      if (source === 'trust') {
        await screen.findByTestId('project-space-create-trust-confirm');
        expect(saved).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      }
      try {
        await waitFor(() => expect(screen.queryByTestId('project-space-create-modal')).toBeNull());
        const card = await screen.findByTestId(`project-space-list-item-${created.id}`);
        expect(reads).toBe(2);
        expect(card.textContent).toContain(created.name);
        expect(container.firstChild).toBe(mountedRoot);
        expect(invoke).toHaveBeenCalledWith(IPC_DOMAINS.PROJECT,
          source === 'promote' ? 'promoteToSpace' : 'createSpace',
          source === 'promote' ? { projectId: created.id } : {
            name: created.name, workspacePath: created.workspacePath,
            ...(source === 'trust' ? { trustAcknowledged: true } : {}),
          });
        // The older response arrives last; it must not erase the newly created card.
        await act(async () => { oldRead.resolve(ok([existing])); });
        expect(screen.getByTestId(`project-space-list-item-${created.id}`)).toBe(card);
        fireEvent.click(card);
        expect(onSelect).toHaveBeenCalledWith(created.id);
      } finally {
        await act(async () => { oldRead.resolve(ok([existing])); });
      }
    },
  );

  it('ignores a superseded list failure after the create refresh succeeds', async () => {
    const oldRead = deferred<ReturnType<typeof ok> | { success: false; error: { message: string } }>();
    let reads = 0;
    invoke.mockImplementation(async (_domain: string, action: string, payload?: Record<string, unknown>) => {
      if (action === 'listWithActivity') {
        if (!payload?.spacesOnly) return ok([]);
        return ++reads === 1 ? oldRead.promise : ok([created]);
      }
      if (action === 'createSpace') return ok(created);
      return ok({ state: 'trusted', dangerousItems: [], blockedItems: [] });
    });
    openCreate();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    try {
      await screen.findByTestId(`project-space-list-item-${created.id}`);
      await act(async () => { oldRead.resolve({ success: false, error: { message: 'old read failed' } }); });
      expect(screen.getByTestId(`project-space-list-item-${created.id}`)).toBeTruthy();
    } finally {
      await act(async () => { oldRead.resolve(ok([])); });
    }
  });

  it('keeps concurrent reads deduped across unrelated or failed writes', async () => {
    const pending = deferred<ReturnType<typeof ok>>();
    invoke.mockImplementation(async (domain: string, action: string) => {
      if (action === 'listWithActivity') return pending.promise;
      return domain === IPC_DOMAINS.PROJECT
        ? { success: false, error: { message: 'write failed' } }
        : ok(null);
    });
    const read = () => ipcService.invokeDomain(IPC_DOMAINS.PROJECT, 'listWithActivity');
    const first = read();
    await ipcService.invokeDomain(IPC_DOMAINS.SESSION, 'create');
    await expect(ipcService.invokeDomain(IPC_DOMAINS.PROJECT, 'createSpace')).rejects.toThrow('write failed');
    const second = read();
    expect(invoke.mock.calls.filter(([, action]) => action === 'listWithActivity')).toHaveLength(1);
    pending.resolve(ok([existing]));
    expect(await first).toEqual(await second);
  });
});
