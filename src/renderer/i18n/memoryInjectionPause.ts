// Settings > memory > entries > injectionPaused 文案（zh/en 相邻维护）。
// 拆成叶子模块（zhSkillCaution 先例）：zhSettingsWork/enSettingsWork 已贴着 max-lines=1000
// 棘轮，内嵌块加不进 N-MEM-SOURCE-WRONG-FEEDBACK 的 user_* 新句。结构与 en.ts satisfies 锁对齐。
export const memoryInjectionPauseZh = {
  badge: '已暂停自动带上',
  badgeUserWrong: '你标记为不对',
  badgeUserOutdated: '你标记为过时了',
  neverUsed: '这条记忆一直没被用到，{date} 起不再自动带进对话。它还在库里，搜索和读取照常可用。',
  staleUsed: '这条记忆很久没再被用到，{date} 起不再自动带进对话。它还在库里，搜索和读取照常可用。',
  userWrong: '你标记为不对，{date} 起不再自动带进对话。它还在库里，搜索和读取照常可用。',
  userOutdated: '你标记为过时了，{date} 起不再自动带进对话。它还在库里，搜索和读取照常可用。',
  flagCount: '被标记过 {count} 次',
  resume: '恢复自动带上',
  resumeSuccess: '已恢复，之后的对话会重新自动带上这条记忆',
  resumeFailed: '恢复失败',
};

export const memoryInjectionPauseEn = {
  badge: 'Auto-include paused',
  badgeUserWrong: 'You marked it wrong',
  badgeUserOutdated: 'You marked it outdated',
  neverUsed: 'This memory was never used, so since {date} it is no longer added to conversations automatically. It is still saved and can be searched and read.',
  staleUsed: 'This memory has not been used for a long time, so since {date} it is no longer added to conversations automatically. It is still saved and can be searched and read.',
  userWrong: 'You marked this memory as wrong, so since {date} it is no longer added to conversations automatically. It is still saved and can be searched and read.',
  userOutdated: 'You marked this memory as outdated, so since {date} it is no longer added to conversations automatically. It is still saved and can be searched and read.',
  flagCount: 'Flagged {count} time(s)',
  resume: 'Resume auto-include',
  resumeSuccess: 'Resumed. Future conversations will include this memory again.',
  resumeFailed: 'Resume failed',
};
