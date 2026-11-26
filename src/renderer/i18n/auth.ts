// N-FIX-EN-UI-AUTH-MODALS-HARDCODED-ZH：账号弹窗链路的用户可见文案。
// passwordReset 组 = PasswordResetModal.tsx（设置新密码弹窗）；
// errors 组 = authStore.ts 里渲染进这两类弹窗的错误提示（formatAuthErrorMessage
// 与 getResultErrorMessage 的兜底文案）。AuthModal.tsx 的界面文案在 authModal.ts。
export const authZh = {
  auth: {
    passwordReset: {
      title: '设置新密码',
      infoBanner: '请设置您的新密码',
      newPassword: '新密码',
      newPasswordPlaceholder: '至少6位',
      confirmPassword: '确认密码',
      confirmPasswordPlaceholder: '再次输入密码',
      mismatchError: '两次输入的密码不一致',
      tooShortError: '密码长度至少为6位',
      strengthTooShort: '密码太短',
      strengthWeak: '密码强度：弱',
      strengthMedium: '密码强度：中',
      strengthStrong: '密码强度：强',
      submit: '确认修改',
      successTitle: '密码已更新',
      successBody: '您的密码已成功重置，现在可以使用新密码登录了。',
      done: '完成',
    },
    errors: {
      operationFailed: '操作失败',
      backendStartup: '登录服务启动失败，请重启应用或检查网络后重试。',
      backendReachability: '登录服务暂时连不上，请检查网络或代理设置后重试。',
      invalidCredentials: '邮箱或密码不正确，请检查后重试。',
      emailNotConfirmed: '邮箱还没有完成验证，请先打开验证邮件。',
      emailAlreadyRegistered: '这个邮箱已经注册过了，请直接登录或找回密码。',
      quickLoginFailed: '快捷登录失败',
      sendResetMailFailed: '发送重置邮件失败',
      updatePasswordFailed: '更新密码失败',
      verifyResetLinkFailed: '验证重置链接失败',
    },
  },
};

export const authEn = {
  auth: {
    passwordReset: {
      title: 'Set new password',
      infoBanner: 'Choose a new password for your account',
      newPassword: 'New password',
      newPasswordPlaceholder: 'At least 6 characters',
      confirmPassword: 'Confirm password',
      confirmPasswordPlaceholder: 'Re-enter your password',
      mismatchError: 'The two passwords do not match',
      tooShortError: 'Password must be at least 6 characters',
      strengthTooShort: 'Password too short',
      strengthWeak: 'Password strength: weak',
      strengthMedium: 'Password strength: medium',
      strengthStrong: 'Password strength: strong',
      submit: 'Confirm',
      successTitle: 'Password updated',
      successBody: 'Your password has been reset. You can now sign in with your new password.',
      done: 'Done',
    },
    errors: {
      operationFailed: 'Operation failed',
      backendStartup: 'The sign-in service failed to start. Restart the app or check your network and try again.',
      backendReachability: 'The sign-in service is temporarily unreachable. Check your network or proxy settings and try again.',
      invalidCredentials: 'Incorrect email or password. Please check and try again.',
      emailNotConfirmed: 'This email has not been verified yet. Open the verification email first.',
      emailAlreadyRegistered: 'This email is already registered. Sign in or reset your password instead.',
      quickLoginFailed: 'Quick sign-in failed',
      sendResetMailFailed: 'Failed to send the reset email',
      updatePasswordFailed: 'Failed to update the password',
      verifyResetLinkFailed: 'Failed to verify the reset link',
    },
  },
};
