/**
 * Exits on a failed delegation receipt in the chat: look at the member, or send a
 * ready-made retry sentence as an ordinary user message with one click.
 */
export const delegationFailedActionsZh = {
  delegationFailedActions: {
    viewDetails: '查看详情',
    retry: '重试',
    retryDraft: '请重新做一下刚才失败的任务：{task}',
    retryBusy: '请等当前任务完成后再重试',
    superseded: '和下面最近一次是同一个问题',
  },
};

export const delegationFailedActionsEn = {
  delegationFailedActions: {
    viewDetails: 'View details',
    retry: 'Retry',
    retryDraft: 'Please redo the task that just failed: {task}',
    retryBusy: 'Wait for the current task to finish',
    superseded: 'Same problem as the latest attempt, shown below',
  },
};
