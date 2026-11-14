// 用户主动停止（含「停止并退出」）后重开会话，停靠行旁的一句说明。独立词条避免 chatInput.ts / chatTranscript.ts 顶格。

export const durableStoppedZh = {
  durableStopped: {
    userStop: '你停止了这次任务 · 点「继续」可接着做',
  },
};

export const durableStoppedEn: typeof durableStoppedZh = {
  durableStopped: {
    userStop: 'You stopped this task · press Continue to pick it up',
  },
};
