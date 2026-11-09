// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrashedRoleEntry } from '../../../src/shared/contract/roleAssets';

const listDeletedRoles = vi.fn<() => Promise<TrashedRoleEntry[]>>();
const restoreDeletedRole = vi.fn<(_trashId: string) => Promise<{ roleId: string }>>();

vi.mock('../../../src/renderer/services/rolesClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/rolesClient')>();
  return {
    ...actual,
    listDeletedRoles: (...args: []) => listDeletedRoles(...args),
    restoreDeletedRole: (...args: [_trashId: string]) => restoreDeletedRole(...args),
  };
});

import { RecentlyDeletedRoles } from '../../../src/renderer/components/features/expert/RecentlyDeletedRoles';

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  listDeletedRoles.mockResolvedValue([
    {
      trashId: 'trash-internal',
      roleId: 'role-internal',
      displayName: '小满',
      deletedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ]);
  restoreDeletedRole.mockResolvedValue({ roleId: 'role-internal' });
});

describe('RecentlyDeletedRoles', () => {
  it('loads the persistent list and restores one entry without rendering internal ids', async () => {
    const onRestored = vi.fn();
    render(<RecentlyDeletedRoles onRestored={onRestored} />);

    fireEvent.click(screen.getByTestId('recently-deleted-toggle'));
    await waitFor(() => expect(screen.getByText('小满')).toBeTruthy());
    expect(screen.getByText(/删除 2 天前 · 还有 28 天可恢复/)).toBeTruthy();
    expect(screen.queryByText('trash-internal')).toBeNull();
    expect(screen.queryByText('role-internal')).toBeNull();

    fireEvent.click(screen.getByTestId('recently-deleted-restore'));
    await waitFor(() => expect(restoreDeletedRole).toHaveBeenCalledWith('trash-internal'));
    await waitFor(() => expect(screen.queryByText('小满')).toBeNull());
    expect(onRestored).toHaveBeenCalledTimes(1);
  });
});
