// 后台任务「已取消 / 被拒绝 / 最后一条命令没跑成功」时给用户看的收线说明（语言包，放 i18n/ 目录以免被 CJK 棘轮当成硬编码）。
// 文本原样迁自 shared/constants/sessionCommandCenter.ts；那边的 format*/is* 导出与行为不变。
export const SESSION_TASK_USER_DENIED_MESSAGES = {
  zh: '你拒绝了这一步，任务已停止。',
  en: 'You declined this step, so the task was stopped.',
} as const;

export const SESSION_TASK_CANCELLED_CLOSING_MESSAGES = {
  zh: '这个后台任务已取消。',
  en: 'This background task was cancelled.',
} as const;

export const SESSION_TASK_COMMAND_FAILED_LEAD = {
  zh: '后台任务没能完成：命令 ',
  en: 'The background task could not finish: the command ',
} as const;

/** lead 传 SESSION_TASK_COMMAND_FAILED_LEAD 里同一语言的那句；拼出的整句与迁移前逐字相同。 */
export const SESSION_TASK_COMMAND_FAILED_SENTENCE = {
  zh: (lead: string, command: string, reason?: string) => `${lead}${command} 没有运行成功${reason ? `（${reason}）` : ''}，已停止。`,
  en: (lead: string, command: string, reason?: string) => `${lead}${command} did not run successfully${reason ? ` (${reason})` : ''}, so it stopped.`,
} as const;
