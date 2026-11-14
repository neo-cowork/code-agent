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
    wakeFailed: '后台任务「{title}」已结束；自动汇报这一步没能完成，恢复原账号登录后可查看任务结果，也可以直接问我。',
    minimizedLabel: '{count} 个后台任务',
    minimizedFinishedLabel: '{count} 个已结束后台任务',
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
    wakeFailed: 'Background task "{title}" has ended; the automatic report could not be completed — sign back in to the original account to view the task result, or ask me directly.',
    minimizedLabel: '{count} background tasks',
    minimizedFinishedLabel: '{count} finished background tasks',
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
