// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';
import { enSettingsCore } from '../../../src/renderer/i18n/enSettingsCore';
import { toast } from '../../../src/renderer/hooks/useToast';

const invoke = vi.hoisted(() => vi.fn());
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, invokeDomain, on: vi.fn(), off: vi.fn() },
}));

import { GeneralSettings, resolvePermissionRulesBlur } from '../../../src/renderer/components/features/settings/tabs/GeneralSettings';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

const invalidCopy = enSettingsCore.general.permissions.userRules.invalid;
const zhInvalid = zh.settings.general.permissions.userRules.invalid;

function setCalls(): unknown[][] {
  return invokeDomain.mock.calls.filter((call) => call[1] === 'set');
}

describe('permission rule blur decision', () => {
  it('does not hand an invalid line to persist, and does hand a valid set', () => {
    expect(resolvePermissionRulesBlur('allow', 'Read\nBash(', invalidCopy)).toEqual({
      ok: false,
      message: `Bash(: ${invalidCopy.malformed}`,
    });
    expect(resolvePermissionRulesBlur('allow', 'Bash(git *)\n\nRead\n', invalidCopy)).toEqual({
      ok: true,
      rules: ['Bash(git *)', 'Read'],
    });
  });

  it('states that allowing every Bash command is not permitted', () => {
    const decision = resolvePermissionRulesBlur('allow', 'Bash(*)', invalidCopy);
    expect(decision).toEqual({
      ok: false,
      message: `Bash(*): ${invalidCopy.allowAllBash}`,
    });
    expect(invalidCopy.allowAllBash).toContain('Allowing every Bash command is not permitted');
    expect(invalidCopy.allowAllBash).toContain('ask list');
    expect(zhInvalid.allowAllBash).toContain('不允许放行全部 Bash 命令');
    expect(zhInvalid.allowAllBash).toContain('询问列表');
  });
});

describe('GeneralSettings permission rule editor', () => {
  beforeEach(() => {
    invoke.mockReset();
    invokeDomain.mockReset();
    invoke.mockResolvedValue(undefined);
    // 规则编辑现在按 isAdmin 门禁（host 侧 settings set 对 'permissions' 恒 403，
    // N-PERMRULES-UI-FIX-ADMIN）——这里的用例全是管理员编辑行为，把渲染态对齐
    // 真实登录管理员，不再依赖「未登录也能编」这个从不存在的状态。
    useAuthStore.setState({ user: { id: 'test-admin', email: 'admin@test.dev', isAdmin: true } });
    invokeDomain.mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
        return Promise.resolve({
          permissions: {
            inheritance: 'strict-inherit',
            deny: [],
            ask: [],
            allow: ['Read'],
          },
        });
      }
      if (domain === IPC_DOMAINS.SETTINGS && action === 'getBudgetStatus') {
        return Promise.resolve({ scopes: { unattended: { currentCost: 0 } } });
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function renderEditor(): Promise<HTMLTextAreaElement> {
    render(<GeneralSettings />);
    const allow = await screen.findByDisplayValue('Read');
    return allow as HTMLTextAreaElement;
  }

  it('renders look-ups ON by default for a non-admin and sends exactly the OFF patch', async () => {
    useAuthStore.setState({ user: { id: 'local-owner', email: 'owner@test.dev', isAdmin: false } });
    await renderEditor();
    const toggle = screen.getByRole('switch', { name: zh.settings.general.permissions.readOnlyLookups.title });
    const success = vi.spyOn(toast, 'success');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);

    await waitFor(() => expect(success).toHaveBeenCalledWith(zh.settings.general.permissions.readOnlyLookups.savedOff));
    expect(setCalls()).toEqual([[IPC_DOMAINS.SETTINGS, 'set', { permissions: { readOnlyProbePlan: false } }]]);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);
    await waitFor(() => expect(success).toHaveBeenCalledWith(zh.settings.general.permissions.readOnlyLookups.savedOn));
    expect(setCalls()[1]).toEqual([IPC_DOMAINS.SETTINGS, 'set', { permissions: { readOnlyProbePlan: true } }]);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('reverts the look-ups toggle and shows the existing error toast when saving fails', async () => {
    await renderEditor();
    const toggle = screen.getByRole('switch', { name: zh.settings.general.permissions.readOnlyLookups.title });
    const error = vi.spyOn(toast, 'error');
    const success = vi.spyOn(toast, 'success');
    invokeDomain.mockRejectedValueOnce(new Error('save unavailable'));

    fireEvent.click(toggle);

    await waitFor(() => expect(error).toHaveBeenCalledWith(zh.settings.general.permissions.saveFailedPrefix + 'save unavailable'));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.hasAttribute('disabled')).toBe(false);
    expect(success).not.toHaveBeenCalled();
  });

  it('keeps an invalid line on screen and does not persist it, then persists a valid set', async () => {
    const allow = await renderEditor();
    const success = vi.spyOn(toast, 'success');

    fireEvent.change(allow, { target: { value: 'Bash(' } });
    fireEvent.blur(allow);

    expect(allow.value).toBe('Bash(');
    expect(screen.getByText(`Bash(: ${zhInvalid.malformed}`)).toBeTruthy();
    expect(setCalls()).toEqual([]);
    expect(success).not.toHaveBeenCalled();

    fireEvent.change(allow, { target: { value: 'Bash(git *)\nRead' } });
    fireEvent.blur(allow);

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
        permissions: { allow: ['Bash(git *)', 'Read'] },
      });
    });
    expect(screen.queryByText(`Bash(: ${zhInvalid.malformed}`)).toBeNull();
    expect(allow.value).toBe('Bash(git *)\nRead');
  });

  it('shows the allow-all Bash reason and does not persist', async () => {
    const allow = await renderEditor();

    fireEvent.change(allow, { target: { value: 'Bash(*)' } });
    fireEvent.blur(allow);

    expect(allow.value).toBe('Bash(*)');
    expect(screen.getByText(`Bash(*): ${zhInvalid.allowAllBash}`)).toBeTruthy();
    expect(setCalls()).toEqual([]);
  });

  it('saves an admin-edited allow rule with exactly one set call and a success toast (N-PERMRULES-UI-FIX-ADMIN)', async () => {
    const allow = await renderEditor();
    const success = vi.spyOn(toast, 'success');

    fireEvent.change(allow, { target: { value: 'Bash(npm test)' } });
    fireEvent.blur(allow);

    await waitFor(() => {
      expect(success).toHaveBeenCalledTimes(1);
    });
    expect(setCalls()).toHaveLength(1);
    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
      permissions: { allow: ['Bash(npm test)'] },
    });
    expect(success).toHaveBeenCalledWith(
      `allow${zh.settings.general.permissions.ruleSavedPrefix}1${zh.settings.general.permissions.ruleSavedSuffix}`,
    );
  });
});
