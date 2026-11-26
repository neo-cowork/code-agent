/**
 * Exits on a failed or cancelled delegation receipt in the chat: look at the member, or send a
 * ready-made retry sentence as an ordinary user message with one click.
 */
export const delegationFailedActionsZh = {
  delegationFailedActions: {
    viewDetails: '查看详情',
    retry: '重试',
    tryAnotherWay: '换个方式',
    deleteRetryDraft: '请在后台再试一次，删除这些还在的文件：{files}。',
    deleteAnotherWayDraft: '上次删除受阻，这些文件还在：{files}。请试试别的办法。',
    remainingFiles: '剩下的文件',
    retryDraft: '请重新做一下刚才失败的任务：{task}',
    cancelledRetryDraft: '请重新做一下我刚才取消的任务：{task}',
    retryBusy: '请等当前任务完成后再重试',
    superseded: '和下面最近一次是同一个问题',
  },
};

export const delegationFailedActionsEn = {
  delegationFailedActions: {
    viewDetails: 'View details',
    retry: 'Retry',
    tryAnotherWay: 'Try another way',
    deleteRetryDraft: 'Please try again in the background and delete these remaining files: {files}.',
    deleteAnotherWayDraft: 'The last deletion was blocked and these files are still there: {files}. Please try another way.',
    remainingFiles: 'the remaining files',
    retryDraft: 'Please redo the task that just failed: {task}',
    cancelledRetryDraft: 'Please redo the task I just cancelled: {task}',
    retryBusy: 'Wait for the current task to finish',
    superseded: 'Same problem as the latest attempt, shown below',
  },
};
