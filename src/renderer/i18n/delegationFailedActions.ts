/**
 * Exits on a failed delegation receipt in the chat: look at the member, or put a
 * ready-to-send retry sentence into the composer (never auto-sent).
 */
export const delegationFailedActionsZh = {
  delegationFailedActions: {
    viewDetails: '查看详情',
    retry: '重试',
    retryDraft: '请重新做一下刚才失败的任务：{task}',
    superseded: '和下面最近一次是同一个问题',
  },
};

export const delegationFailedActionsEn = {
  delegationFailedActions: {
    viewDetails: 'View details',
    retry: 'Retry',
    retryDraft: 'Please redo the task that just failed: {task}',
    superseded: 'Same problem as the latest attempt, shown below',
  },
};
