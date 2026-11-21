// 回复下方记忆来源标注（普通用户视图）词条，zh/en 相邻维护。只有按条目注入时才出现，标签永远带条数。
export const memorySourceZh = {
  memorySource: {
    usedCount: '参考了 {count} 条记忆',
    hint: '来自你保存的记忆 / 之前的会话。可在 设置 → 记忆 中管理。',
    toggleTitle: '查看本条回复参考了哪些记忆',
    markWrong: '不对',
    markOutdated: '过时了',
    markedWrong: '已停用 · 你标记为不对',
    markedOutdated: '已停用 · 你标记为过时了',
    undo: '撤销',
    markWrongTitle: '这条记忆不对：停用后不再自动带进对话',
    markOutdatedTitle: '这条记忆过时了：停用后不再自动带进对话',
    undoTitle: '撤销标记，恢复自动带上这条记忆',
    markFailed: '没标记上，请重试',
  },
};

export const memorySourceEn = {
  memorySource: {
    usedCount: 'Used {count} memories',
    hint: 'From your saved memory / earlier sessions. Manage in Settings → Memory.',
    toggleTitle: 'See which memories this reply used',
    markWrong: 'Wrong',
    markOutdated: 'Outdated',
    markedWrong: 'Paused · you marked it wrong',
    markedOutdated: 'Paused · you marked it outdated',
    undo: 'Undo',
    markWrongTitle: 'This memory is wrong: stop including it automatically',
    markOutdatedTitle: 'This memory is outdated: stop including it automatically',
    undoTitle: 'Undo the flag and resume auto-include',
    markFailed: "Couldn't mark it, try again",
  },
};
