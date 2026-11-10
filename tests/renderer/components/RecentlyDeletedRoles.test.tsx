// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainInvokeError } from '../../../src/renderer/services/ipcService';
import { toast } from '../../../src/renderer/hooks/useToast';
import type { TrashedRoleEntry } from '../../../src/shared/contract/roleAssets';

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: i18nState.language === 'en' ? en : zh, language: i18nState.language }) };
});

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

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
  i18nState.language = 'zh';
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

  it.each([
    ['zh', '今天删除 · 还有 30 天可恢复', '删除 1 天前 · 还有 29 天可恢复', '删除 2 天前 · 还有 28 天可恢复', '0 天前'],
    ['en', 'Deleted today · 30 days left to restore', 'Deleted 1 days ago · 29 days left to restore', 'Deleted 2 days ago · 28 days left to restore', '0 days ago'],
  ] as const)('renders same-day, one-day and two-day copy in %s', async (language, today, yesterday, older, zeroDays) => {
    i18nState.language = language;
    listDeletedRoles.mockResolvedValue([0, 1, 2].map((days) => ({
      trashId: `trash-${days}`,
      roleId: `role-${days}`,
      displayName: `Expert ${days}`,
      deletedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000 - 60_000).toISOString(),
    })));
    render(<RecentlyDeletedRoles />);
    fireEvent.click(screen.getByTestId('recently-deleted-toggle'));
    expect(await screen.findByText(today)).toBeTruthy();
    expect(screen.getByText(yesterday)).toBeTruthy();
    expect(screen.getByText(older)).toBeTruthy();
    expect(screen.queryByText(zeroDays, { exact: false })).toBeNull();
  });

  it.each([
    ['zh', 'ROLE_RESTORE_CONFLICT', '这位专家已经存在，没有覆盖现有内容。'],
    ['en', 'ROLE_RESTORE_CONFLICT', 'This expert already exists, so nothing was overwritten.'],
    ['zh', 'INTERNAL_ERROR', '恢复失败，请稍后再试。'],
    ['en', 'INTERNAL_ERROR', 'Could not restore this expert. Try again later.'],
  ] as const)('keeps the row and shows %s message for %s', async (language, code, message) => {
    i18nState.language = language;
    restoreDeletedRole.mockRejectedValue(new DomainInvokeError(code, 'Restore rejected'));
    const onRestored = vi.fn();
    render(<RecentlyDeletedRoles onRestored={onRestored} />);
    fireEvent.click(screen.getByTestId('recently-deleted-toggle'));
    await screen.findByText('小满');
    fireEvent.click(screen.getByTestId('recently-deleted-restore'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
    expect(screen.getByTestId('recently-deleted-role-row').textContent).toContain('小满');
    expect(onRestored).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

});
