// @vitest-environment jsdom
// 开启完全访问失败时不静默：确认框保留、显示人话原因、可重试；成功才关框。
// invokeDomain 用真实返回形状：host 失败 → DomainInvokeError(code,message)；档位未变 → {changed:false, mode:'default'}。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

const mocks = vi.hoisted(() => ({ invokeDomain: vi.fn() }));

vi.mock('../../../src/renderer/services/ipcService', () => {
  class DomainInvokeError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
      this.name = 'DomainInvokeError';
    }
  }
  return {
    default: { on: vi.fn().mockReturnValue(() => undefined) },
    invokeDomain: mocks.invokeDomain,
    DomainInvokeError,
  };
});

import { DomainInvokeError } from '../../../src/renderer/services/ipcService';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { PermissionToggle } from '../../../src/renderer/components/features/chat/ChatInput/PermissionToggle';

const T = zh.permissionTier;

function mockSetMode(handler: () => unknown) {
  mocks.invokeDomain.mockImplementation(async (_d: string, action: string) => {
    if (action === 'getSessionPermissionMode') return { mode: 'default' };
    return handler();
  });
}

async function openConfirm() {
  render(<PermissionToggle />);
  fireEvent.click(screen.getByTitle(T.buttonTitle));
  fireEvent.click(await screen.findByText(zh.settings.general.permissions.permissionModes.bypassPermissions.title));
  expect(screen.getByText(T.bypassConfirmText)).toBeTruthy();
}

describe('PermissionToggle 开启完全访问失败反馈', () => {
  beforeEach(() => {
    mocks.invokeDomain.mockReset();
    useSessionStore.setState({ currentSessionId: 's1' });
  });
  afterEach(() => cleanup());

  it('FORBIDDEN：显示管理员提示，确认框不关，无重试/开启按钮，只能取消', async () => {
    mockSetMode(() => { throw new DomainInvokeError('FORBIDDEN', 'Session permission mode: Admin permission required'); });
    await openConfirm();
    fireEvent.click(screen.getByText(T.enable));
    expect(await screen.findByText(T.enableError.forbidden)).toBeTruthy();
    expect(screen.getByText(T.bypassConfirmText)).toBeTruthy();
    expect(screen.queryByText(T.retry)).toBeNull();
    expect(screen.queryByText(T.enable)).toBeNull();
    expect(screen.getByText(zh.common.cancel)).toBeTruthy();
    expect(document.body.textContent).not.toContain('FORBIDDEN');
  });

  it('ADMIN_VERIFICATION_PENDING：显示资料没取到，按钮变「重试」；重试成功后关框', async () => {
    let calls = 0;
    mockSetMode(() => {
      calls += 1;
      if (calls === 1) throw new DomainInvokeError('ADMIN_VERIFICATION_PENDING', 'Session permission mode: 账号资料暂时没取到，请稍后重试');
      return { changed: true, mode: 'bypassPermissions' };
    });
    await openConfirm();
    fireEvent.click(screen.getByText(T.enable));
    expect(await screen.findByText(T.enableError.pending)).toBeTruthy();
    expect(screen.getByText(T.bypassConfirmText)).toBeTruthy();
    expect(document.body.textContent).not.toContain('ADMIN_VERIFICATION_PENDING');

    fireEvent.click(screen.getByText(T.retry));
    await waitFor(() => expect(screen.queryByText(T.bypassConfirmText)).toBeNull());
    expect(screen.queryByText(T.enableError.pending)).toBeNull();
    expect(calls).toBe(2);
  });

  it('其他错误码：显示通用失败提示，确认框保留，仍可再点开启', async () => {
    mockSetMode(() => { throw new DomainInvokeError('INTERNAL', 'boom'); });
    await openConfirm();
    fireEvent.click(screen.getByText(T.enable));
    expect(await screen.findByText(T.enableError.other)).toBeTruthy();
    expect(screen.getByText(T.bypassConfirmText)).toBeTruthy();
    expect(screen.getByText(T.enable)).toBeTruthy();
  });

  it('响应成功但 mode 没变（{changed:false, mode:default}）：不当成功关框，显示通用失败提示', async () => {
    mockSetMode(() => ({ changed: false, mode: 'default' }));
    await openConfirm();
    fireEvent.click(screen.getByText(T.enable));
    expect(await screen.findByText(T.enableError.other)).toBeTruthy();
    expect(screen.getByText(T.bypassConfirmText)).toBeTruthy();
  });

  it('成功：关闭确认框且不显示错误', async () => {
    mockSetMode(() => ({ changed: true, mode: 'bypassPermissions' }));
    await openConfirm();
    fireEvent.click(screen.getByText(T.enable));
    await waitFor(() => expect(screen.queryByText(T.bypassConfirmText)).toBeNull());
    expect(screen.queryByText(T.enableError.other)).toBeNull();
  });
});
