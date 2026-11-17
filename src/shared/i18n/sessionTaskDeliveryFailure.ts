// 后台任务交付失败的双语说明（语言包，放 i18n/ 目录以免被 CJK 棘轮当成硬编码）
export const SESSION_TASK_DELIVERY_FAILURE_MESSAGES = {
  zh: {
    approval_timeout: '后台任务没能完成：需要你批准的操作一直没有等到批准，已停止。',
    repair_exhausted: '后台任务没能完成：它调用的工具连续出错，已停止。',
  },
  en: {
    approval_timeout: 'The background task could not finish: an action that needed your approval was never approved, so it stopped.',
    repair_exhausted: 'The background task could not finish: a tool it used kept failing, so it stopped.',
  },
} as const;
