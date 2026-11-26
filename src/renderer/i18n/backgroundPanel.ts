import { BACKGROUND_TASK_PREANNOUNCE } from '@shared/constants/backgroundTaskPreannounce';
// ============================================================================
// 后台任务面板词条（BackgroundSessionPanel）—— zh/en 同文件相邻维护。
// 独立文件避免 zh.ts/en.ts 撞 max-lines 棘轮（同 chatInput.ts 先例）。
// ============================================================================

export const backgroundPanelZh = {
  backgroundPanel: {
    title: '后台任务',
    preannounce: BACKGROUND_TASK_PREANNOUNCE.zh,
    interrupted: '应用重启时这个后台任务还没做完，已被中断，结果没能送回这里。需要的话请重新发起。',
    handoffEnded: {
      interrupted: '后台任务已中断，结果不会再送达。',
      failed: '后台任务没有完成，结果不会再送达。',
    },
    shellCommandFailed: '命令未能成功完成',
    helperNotDone: {
      failed: '这个后台任务没有做完：中间有一步没做成。补上缺少的内容后，可以让我再试一次。',
      partial: '这个后台任务只做完了一部分，还有几步没做成。补上缺少的内容后，可以让我接着做。',
    },
    helperNotDoneWithReason: {
      failed: '这个后台任务没有做完：{reason}。补上缺少的内容后，可以让我再试一次。',
      partial: '这个后台任务只做完了一部分：{reason}。补上缺少的内容后，可以让我接着做。',
    },
    shellOfNotDoneTask: '它所属的后台任务没有做完',
    shellTaskStarted: '已在后台开始执行',
    shellTaskFinished: '「{name}」已完成{duration}。',
    shellTaskFailed: '「{name}」失败：{reason}{duration}。',
    shellTaskStopped: '「{name}」已停止{duration}。',
    shellTaskDuration: '，耗时 {time}',
    durationUnderSecond: '不到 1 秒',
    wakeFailedOwnerMissing: '后台任务「{title}」已结束；自动汇报这一步没能完成，恢复原账号登录后可查看任务结果，也可以直接问我。',
    wakeFailedRateLimited: '后台任务「{title}」已结束；模型服务暂时限流，自动汇报没能完成。任务结果在后台任务面板里可以查看，稍后也可以直接问我。',
    wakeFailedMaxIterations: '后台任务「{title}」已结束；自动汇报用完了可用步骤，没能完成。任务结果在后台任务面板里可以查看，也可以直接问我。',
    wakeFailedGeneric: '后台任务「{title}」已结束；自动汇报没能完成。任务结果在后台任务面板里可以查看，也可以直接问我。',
    minimizedLabel: { one: '{count} 个后台任务', other: '{count} 个后台任务' },
    minimizedFinishedLabel: { one: '{count} 个已结束后台任务', other: '{count} 个已结束后台任务' },
    minimizedAria: '展开后台任务面板',
    collapseAria: '收起后台任务面板',
    foregroundHint: '点击任务切换到前台',
    foregroundAria: '把「{title}」切回前台',
    stopAria: '停止「{title}」',
    clearAria: '清除「{title}」',
    maxIterationsLine: '已达轮次上限，已停止（部分结果已保留）',
    durationSeconds: '{n}秒',
    durationMinutes: '{n}分钟',
    durationHours: '{n}小时{m}分钟',
  },
};

export const backgroundPanelEn: typeof backgroundPanelZh = {
  backgroundPanel: {
    title: 'Background tasks',
    preannounce: BACKGROUND_TASK_PREANNOUNCE.en,
    interrupted: 'The app restarted while this background task was still running, so it was interrupted and its result could not be delivered. Please start it again if you still need it.',
    handoffEnded: {
      interrupted: 'The background task was interrupted, so no result will follow.',
      failed: 'The background task failed, so no result will follow.',
    },
    shellCommandFailed: 'The command did not finish successfully',
    helperNotDone: {
      failed: 'This background task is not done: one of its steps did not work. Add what is missing and I can try again.',
      partial: 'This background task is only partly done: some steps did not work. Add what is missing and I can pick it up again.',
    },
    helperNotDoneWithReason: {
      failed: 'This background task is not done: {reason}. Add what is missing and I can try again.',
      partial: 'This background task is only partly done: {reason}. Add what is missing and I can pick it up again.',
    },
    shellOfNotDoneTask: 'The background task it belongs to was not finished',
    shellTaskStarted: 'Started in the background',
    shellTaskFinished: '“{name}” finished{duration}.',
    shellTaskFailed: '“{name}” failed{duration}. {reason}.',
    shellTaskStopped: '“{name}” was stopped{duration}.',
    shellTaskDuration: ', took {time}',
    durationUnderSecond: 'under 1 second',
    wakeFailedOwnerMissing: 'Background task "{title}" has ended; the automatic report could not be completed — sign back in to the original account to view the task result, or ask me directly.',
    wakeFailedRateLimited: 'Background task "{title}" has ended; the model service is temporarily rate-limited, so the automatic report could not be completed. You can view the result in the background task panel, or ask me again later.',
    wakeFailedMaxIterations: 'Background task "{title}" has ended; the automatic report ran out of steps and could not be completed. You can view the result in the background task panel, or ask me directly.',
    wakeFailedGeneric: 'Background task "{title}" has ended; the automatic report could not be completed. You can view the result in the background task panel, or ask me directly.',
    minimizedLabel: { one: '{count} background task', other: '{count} background tasks' },
    minimizedFinishedLabel: { one: '{count} finished background task', other: '{count} finished background tasks' },
    minimizedAria: 'Expand background task panel',
    collapseAria: 'Collapse background task panel',
    foregroundHint: 'Click a task to bring it back',
    foregroundAria: 'Bring "{title}" back to the foreground',
    stopAria: 'Stop "{title}"',
    clearAria: 'Clear "{title}"',
    maxIterationsLine: 'Step limit reached, stopped (partial results kept)',
    durationSeconds: '{n}s',
    durationMinutes: '{n}m',
    durationHours: '{n}h {m}m',
  },
};
