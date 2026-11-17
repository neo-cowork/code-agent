// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthModal } from '../../../src/renderer/components/AuthModal';
import { PasswordResetModal } from '../../../src/renderer/components/PasswordResetModal';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { languages } from '../../../src/renderer/i18n';

// N-FIX-EN-UI-AUTH-MODALS-HARDCODED-ZH：账号弹窗链路的英文 UI 守卫。
// 1) AuthModal.tsx / PasswordResetModal.tsx 的源码剥注释后不得再出现裸 CJK
//    （标识符不可能含 CJK，剩下的 CJK 只可能是字符串字面量或 JSX 文本）；
// 2) 两个弹窗的每个视图（登录 / 注册 / 找回密码 / 重置链接已发送 / 设置新密码表单 /
//    密码更新成功）在 en 下渲染无 CJK，zh 下渲染结果逐字等于改动前的中文文案。

const here = dirname(fileURLToPath(import.meta.url));
const authModalPath = resolve(here, '../../../src/renderer/components/AuthModal.tsx');
const passwordResetModalPath = resolve(here, '../../../src/renderer/components/PasswordResetModal.tsx');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

// Han 统一表意文字 + CJK 标点/全角形式：组件代码里任何位置都不该出现。
const cjkPattern = /[一-鿿、。：「」『』！？＄％＾＋－＝＼｜～（）［］｛｝＂＇；＜＞＠＆＊]/;

function cjkLines(stripped: string): Array<{ no: number; line: string }> {
  return stripped
    .split('\n')
    .map((line, index) => ({ no: index + 1, line: line.trim() }))
    .filter(({ line }) => cjkPattern.test(line));
}

describe('auth modals CJK literal guard (N-FIX-EN-UI-AUTH-MODALS-HARDCODED-ZH)', () => {
  it('AuthModal.tsx keeps no CJK outside comments', () => {
    const offenders = cjkLines(stripComments(readFileSync(authModalPath, 'utf8')));
    expect(
      offenders,
      '裸 CJK 回流到 AuthModal.tsx：用户可见文案请进 src/renderer/i18n/authModal.ts（zh/en 同文件维护）',
    ).toEqual([]);
  });

  it('PasswordResetModal.tsx keeps no CJK outside comments', () => {
    const offenders = cjkLines(stripComments(readFileSync(passwordResetModalPath, 'utf8')));
    expect(
      offenders,
      '裸 CJK 回流到 PasswordResetModal.tsx：用户可见文案请进 src/renderer/i18n/auth.ts 的 auth.passwordReset 组（zh/en 同文件维护）',
    ).toEqual([]);
  });
});

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
  useAuthStore.setState({
    showAuthModal: true,
    showPasswordResetModal: false,
    isAuthenticated: false,
    isLoading: false,
    error: null,
    user: null,
    updatePassword: useAuthStore.getInitialState().updatePassword,
  });
  window.domainAPI = {
    invoke: vi.fn(async (_domain: string, action: string) => {
      if (action === 'getSavedCredentials') return { success: true, data: null };
      if (action === 'signInEmail') {
        return { success: true, data: { success: false, error: 'Invalid login credentials' } };
      }
      return { success: true, data: { success: true } };
    }),
  } as typeof window.domainAPI;
});

afterEach(() => {
  cleanup();
  window.domainAPI = undefined;
});

const han = /\p{Script=Han}/u;
function expectNoCjk(dialog: HTMLElement): void {
  expect(dialog.textContent, 'English UI must not show Chinese characters').not.toMatch(han);
}

describe('AuthModal every-view language coverage', () => {
  it.each(['en', 'zh'] as const)('renders sign-in / sign-up / forgot-password / forgot-password-sent in %s', async (language) => {
    useAppStore.setState({ language });
    const en = language === 'en';
    const text = languages[language].authModal;
    render(<AuthModal />);

    // View 1: sign-in
    expect(screen.getByRole('dialog', { name: en ? 'Sign in' : '登录' })).toBeTruthy();
    expect(screen.getByPlaceholderText(en ? text.passwordPlaceholder : '至少6位')).toBeTruthy();
    expect(screen.getByText(en ? text.email : '邮箱')).toBeTruthy();
    expect(screen.getByText(en ? text.password : '密码')).toBeTruthy();
    expect(screen.getByText(en ? text.rememberPassword : '记住密码')).toBeTruthy();
    expect(screen.getByText(en ? text.forgotPassword : '忘记密码？')).toBeTruthy();
    expect(screen.getByText(languages[language].sidebar.skipSignInSetup)).toBeTruthy();
    if (en) expectNoCjk(screen.getByRole('dialog'));

    // View 2: sign-up (invite code field + hint)
    fireEvent.click(screen.getAllByRole('button', { name: en ? 'Sign up' : '注册' })[0]);
    expect(screen.getByText(en ? text.inviteCode : '邀请码')).toBeTruthy();
    expect(screen.getByText(en ? text.inviteHint : '需要邀请码才能注册，请联系管理员获取')).toBeTruthy();
    expect(screen.getByPlaceholderText(en ? text.invitePlaceholder : '输入邀请码')).toBeTruthy();
    if (en) expectNoCjk(screen.getByRole('dialog'));

    // View 3: forgot-password (reset form)
    fireEvent.click(screen.getAllByRole('button', { name: en ? 'Sign in' : '登录' })[0]);
    fireEvent.click(screen.getByRole('button', { name: en ? 'Forgot password?' : '忘记密码？' }));
    expect(screen.getByRole('dialog', { name: en ? 'Reset password' : '找回密码' })).toBeTruthy();
    expect(screen.getByText(en ? text.backToSignIn : '返回登录')).toBeTruthy();
    expect(screen.getByText(en ? text.resetInstructions : '输入您的注册邮箱，我们将向您发送密码重置链接。')).toBeTruthy();
    expect(screen.getByRole('button', { name: en ? 'Send reset link' : '发送重置链接' })).toBeTruthy();
    if (en) expectNoCjk(screen.getByRole('dialog'));

    // View 4: forgot-password-sent (success panel, driven through the real store resetPassword)
    fireEvent.change(screen.getByPlaceholderText('your@email.com'), { target: { value: 'reader@example.test' } });
    fireEvent.submit(screen.getByRole('button', { name: en ? 'Send reset link' : '发送重置链接' }).closest('form')!);
    await waitFor(() => expect(screen.getByText(en ? 'Reset link sent' : '重置链接已发送')).toBeTruthy());
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain(en ? 'Please check your inbox at' : '请检查您的邮箱');
    expect(dialog.textContent).toContain(en ? 'Click the link in the email to reset your password' : '点击邮件中的链接重置密码');
    expect(screen.getAllByRole('button', { name: en ? 'Back to sign in' : '返回登录' }).length).toBeGreaterThan(0);
    if (en) expectNoCjk(dialog);
  });

  it.each(['en', 'zh'] as const)('shows the localised formatAuthErrorMessage prompt for wrong credentials in %s', async (language) => {
    useAppStore.setState({ language });
    const en = language === 'en';
    render(<AuthModal />);
    const { act } = await import('@testing-library/react');
    await act(async () => {
      expect(await useAuthStore.getState().signInWithEmail('reader@example.test', 'not-a-secret')).toBe(false);
    });
    expect(screen.getByText(en
      ? 'Incorrect email or password. Please check and try again.'
      : '邮箱或密码不正确，请检查后重试。')).toBeTruthy();
    if (en) expectNoCjk(screen.getByRole('dialog'));
  });
});

describe('PasswordResetModal every-view language coverage', () => {
  it.each(['en', 'zh'] as const)('renders the new-password form, inline errors and strength labels in %s', async (language) => {
    useAppStore.setState({ language });
    const en = language === 'en';
    const text = languages[language].auth.passwordReset;
    useAuthStore.setState({ showPasswordResetModal: true });
    render(<PasswordResetModal />);

    // New-password form
    expect(screen.getByRole('dialog', { name: en ? 'Set new password' : '设置新密码' })).toBeTruthy();
    expect(screen.getByText(en ? text.infoBanner : '请设置您的新密码')).toBeTruthy();
    expect(screen.getByText(en ? text.newPassword : '新密码')).toBeTruthy();
    expect(screen.getByText(en ? text.confirmPassword : '确认密码')).toBeTruthy();
    expect(screen.getByPlaceholderText(en ? text.newPasswordPlaceholder : '至少6位')).toBeTruthy();
    expect(screen.getByPlaceholderText(en ? text.confirmPasswordPlaceholder : '再次输入密码')).toBeTruthy();
    expect(screen.getByRole('button', { name: en ? 'Confirm' : '确认修改' })).toBeTruthy();
    if (en) expectNoCjk(screen.getByRole('dialog'));

    // Strength labels (too short / weak / medium / strong)
    const newPassword = screen.getByPlaceholderText(en ? text.newPasswordPlaceholder : '至少6位');
    fireEvent.change(newPassword, { target: { value: '12345' } });
    expect(screen.getByText(en ? 'Password too short' : '密码太短')).toBeTruthy();
    fireEvent.change(newPassword, { target: { value: '1234567' } });
    expect(screen.getByText(en ? 'Password strength: weak' : '密码强度：弱')).toBeTruthy();
    fireEvent.change(newPassword, { target: { value: '1234567890' } });
    expect(screen.getByText(en ? 'Password strength: medium' : '密码强度：中')).toBeTruthy();
    fireEvent.change(newPassword, { target: { value: 'Abcdef1230' } });
    expect(screen.getByText(en ? 'Password strength: strong' : '密码强度：强')).toBeTruthy();
    if (en) expectNoCjk(screen.getByRole('dialog'));

    // Inline error: mismatched passwords, through the real store setError
    fireEvent.change(newPassword, { target: { value: 'abcdef1' } });
    fireEvent.change(screen.getByPlaceholderText(en ? text.confirmPasswordPlaceholder : '再次输入密码'), { target: { value: 'abcdef2' } });
    fireEvent.submit(screen.getByRole('button', { name: en ? 'Confirm' : '确认修改' }).closest('form')!);
    expect(screen.getByText(en ? 'The two passwords do not match' : '两次输入的密码不一致')).toBeTruthy();
    if (en) expectNoCjk(screen.getByRole('dialog'));

    // Inline error: too short (submit event reaches the handler despite the disabled button)
    const form = screen.getByRole('button', { name: en ? 'Confirm' : '确认修改' }).closest('form')!;
    fireEvent.change(screen.getByPlaceholderText(en ? text.newPasswordPlaceholder : '至少6位'), { target: { value: '12345' } });
    fireEvent.change(screen.getByPlaceholderText(en ? text.confirmPasswordPlaceholder : '再次输入密码'), { target: { value: '12345' } });
    fireEvent.submit(form);
    expect(screen.getByText(en ? 'Password must be at least 6 characters' : '密码长度至少为6位')).toBeTruthy();
    if (en) expectNoCjk(screen.getByRole('dialog'));
  });

  it.each(['en', 'zh'] as const)('renders the password-updated success panel in %s', async (language) => {
    useAppStore.setState({ language });
    const en = language === 'en';
    const text = languages[language].auth.passwordReset;
    // updatePassword 的真实实现成功后会关掉弹窗（showPasswordResetModal: false），
    // 成功面板因此只在弹窗仍开时可见——这里只替换动作取 true，其余走真实 store。
    useAuthStore.setState({ showPasswordResetModal: true, updatePassword: vi.fn(async () => true) });
    render(<PasswordResetModal />);
    fireEvent.change(screen.getByPlaceholderText(en ? text.newPasswordPlaceholder : '至少6位'), { target: { value: 'Newpass123' } });
    fireEvent.change(screen.getByPlaceholderText(en ? text.confirmPasswordPlaceholder : '再次输入密码'), { target: { value: 'Newpass123' } });
    fireEvent.submit(screen.getByRole('button', { name: en ? 'Confirm' : '确认修改' }).closest('form')!);
    await waitFor(() => expect(screen.getByText(en ? 'Password updated' : '密码已更新')).toBeTruthy());
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain(en
      ? 'Your password has been reset. You can now sign in with your new password.'
      : '您的密码已成功重置，现在可以使用新密码登录了。');
    expect(screen.getByRole('button', { name: en ? 'Done' : '完成' })).toBeTruthy();
    if (en) expectNoCjk(dialog);
  });

  it.each(['en', 'zh'] as const)('shows the localised store fallback when the password update fails in %s', async (language) => {
    useAppStore.setState({ language });
    const en = language === 'en';
    const text = languages[language].auth.passwordReset;
    // 无 error 的失败结果 → getResultErrorMessage 走 updatePasswordFailed 兜底文案。
    window.domainAPI = {
      invoke: vi.fn(async (_domain: string, action: string) => {
        if (action === 'updatePassword') return { success: true, data: { success: false } };
        return { success: true, data: { success: true } };
      }),
    } as typeof window.domainAPI;
    useAuthStore.setState({ showPasswordResetModal: true });
    render(<PasswordResetModal />);
    fireEvent.change(screen.getByPlaceholderText(en ? text.newPasswordPlaceholder : '至少6位'), { target: { value: 'Newpass123' } });
    fireEvent.change(screen.getByPlaceholderText(en ? text.confirmPasswordPlaceholder : '再次输入密码'), { target: { value: 'Newpass123' } });
    fireEvent.submit(screen.getByRole('button', { name: en ? 'Confirm' : '确认修改' }).closest('form')!);
    await waitFor(() => expect(screen.getByText(en ? 'Failed to update the password' : '更新密码失败')).toBeTruthy());
    if (en) expectNoCjk(screen.getByRole('dialog'));
  });
});
