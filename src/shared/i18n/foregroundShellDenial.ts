// ============================================================================
// 前台轮次丢弃 Bash 调用时的用户可见终态文案（zh/en）
// ============================================================================

const FOREGROUND_SHELL_DENIAL_FINAL_MESSAGES = {
  zh: '本轮前台不直接执行 Shell 命令（Bash），命令没有运行。可以让我把它交给后台代理执行，届时会按你的权限规则询问你。',
  en: 'Shell commands do not run directly in the foreground in this turn, so the command did not run. You can ask me to hand it to a background task, which will ask you according to your permission rules.',
} as const;

export function formatForegroundShellDenialFinalMessage(locale: 'zh' | 'en'): string {
  return FOREGROUND_SHELL_DENIAL_FINAL_MESSAGES[locale];
}
