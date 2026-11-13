// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelDetail } from '../../../src/shared/contract/roleAssets';

const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args), on: () => () => {} },
}));
vi.mock('../../../src/renderer/services/libraryClient', () => ({ listLibraryItems: () => Promise.resolve([]) }));
import { RoleDetailPage } from '../../../src/renderer/components/features/expert/RoleDetailPage';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { expertZh, expertEn } from '../../../src/renderer/i18n/expert';
import { formatLocalDateTime } from '../../../src/renderer/utils/i18nTime';

function fixture(): RolePanelDetail {
  return {
    roleId: 'planner', definition: null, definitionPath: '', history: [],
    proactivity: { level: 'silent' }, visual: { displayName: 'Planner' }, isBuiltin: false,
    personalization: { userExpectation: '', soul: '', boundaries: { disallowExternalSending: false } },
    memories: [undefined, 'role_wake', 'unknown', 'user_manual', 'auto_review'].map((actor, i) => ({
      filename: `preference-${i}.md`, name: `Preference ${i}`, description: 'Weekly planning', content: 'Deadlines first.', updatedAt: '2026-11-09',
      ...(actor ? { lastChange: { actor, timestamp: 1234 } } : {}),
    })),
  };
}
function mount(detail: RolePanelDetail) {
  invokeDomain.mockImplementation((_domain: string, action: string) => Promise.resolve(action === 'detail' ? structuredClone(detail) : []));
  return render(<RoleDetailPage roleId="planner" />);
}
afterEach(() => { cleanup(); vi.clearAllMocks(); useAppStore.setState({ language: 'zh' }); });

describe('RoleDetailPage memory source', () => {
  it.each(['zh', 'en'] as const)('%s shows only role_wake with localized hover copy', async (language) => {
    useAppStore.setState({ language });
    mount(fixture());
    fireEvent.click(await screen.findByTestId('role-detail-tab-records'));
    const copy = (language === 'zh' ? expertZh : expertEn).expert.roleDetail;
    const chip = await screen.findByText(copy.roleWakeLabel, { selector: 'span' });
    // hover 文案带写入时间（N-ROLE-WAKE-OWN-MEMORY-NO-APPROVAL）：模板 {time} 用
    // lastChange.timestamp 的本地化时间填充（夹具 timestamp=1234）。
    expect(chip.title).toBe(copy.roleWakeTooltip.replace('{time}', formatLocalDateTime(1234, language)));
    expect(chip.parentElement?.textContent).toContain('Preference 1');
    for (const i of [0, 2, 3, 4]) {
      expect(screen.getByText(`Preference ${i}`).parentElement?.textContent).not.toContain(copy.roleWakeLabel);
    }
    expect(screen.getAllByText(copy.roleWakeLabel, { selector: 'span' })).toHaveLength(1);
  });

  it('saving edits reloads detail and removes the wake chip', async () => {
    const detail = fixture();
    mount(detail);
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'updateMemory') detail.memories[1].lastChange = { actor: 'user_manual', timestamp: 2000 };
      return Promise.resolve(action === 'detail' ? structuredClone(detail) : []);
    });
    fireEvent.click(await screen.findByTestId('role-detail-tab-records'));
    const chip = await screen.findByText('角色唤醒', { selector: 'span' });
    const row = chip.closest('.p-3') as HTMLElement;
    fireEvent.click(within(row).getByTitle('编辑'));
    fireEvent.change(within(row).getByRole('textbox'), { target: { value: 'Risks first.' } });
    fireEvent.click(within(row).getByText('保存'));
    await waitFor(() => expect(screen.queryByText('角色唤醒', { selector: 'span' })).toBeNull());
    expect(invokeDomain).toHaveBeenCalledWith('domain:roles', 'updateMemory', expect.objectContaining({ roleId: 'planner', filename: 'preference-1.md', content: 'Risks first.' }));
  });

  it('expert.ts roleDetail zh/en keys stay in parity', () => {
    expect(Object.keys(expertEn.expert.roleDetail).sort()).toEqual(Object.keys(expertZh.expert.roleDetail).sort());
  });
});
