// ============================================================================
// 前台轮次丢弃 Bash 调用时的用户可见终态文案（zh/en）
// ============================================================================

const FOREGROUND_SHELL_DENIAL_FINAL_MESSAGES = {
  zh: '我这边没法直接帮你执行这条命令，命令没有运行。可以让我交给后台任务来做，届时会按你的权限规则询问你。',
  en: 'I am not able to run this command for you directly, so it did not run. I can hand it to a background task instead, which will ask you according to your permission rules.',
} as const;

export function formatForegroundShellDenialFinalMessage(locale: 'zh' | 'en'): string {
  return FOREGROUND_SHELL_DENIAL_FINAL_MESSAGES[locale];
}
