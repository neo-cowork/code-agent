// 停住的任务在输入框上方的一句原因（谁/为什么停）。操作入口只在输入框里（继续/放弃），这里只说明。
// 环境授权停车（env_blocked）不是中断：说清在等什么，授权后自动续做。独立词条避免 chatInput.ts / chatTranscript.ts 顶格。

export const durableStoppedZh = {
  durableStopped: {
    userStop: '你停止了这次任务 · 点「继续」可接着做',
    budgetExhausted: '应用多次意外退出，任务停在这里 · 点「继续」接着做',
    guardHalt: '上一步不确定有没有做完，任务停在这里 · 继续前会再确认',
    otherStop: '任务停在这里 · 点「继续」接着做',
    envWaiting: '等你允许{target} · 允许后自动继续',
    envWaitingStep: '等你允许{target}',
    envTargetFallback: '所需权限',
  },
};

export const durableStoppedEn: typeof durableStoppedZh = {
  durableStopped: {
    userStop: 'You stopped this task · press Continue to pick it up',
    budgetExhausted: 'The app quit unexpectedly several times, so the task paused here · press Continue to pick it up',
    guardHalt: 'It is unclear whether the last step finished, so the task paused here · you will confirm before continuing',
    otherStop: 'The task paused here · press Continue to pick it up',
    envWaiting: 'Waiting for you to allow {target} · it continues by itself once allowed',
    envWaitingStep: 'Waiting for you to allow {target}',
    envTargetFallback: 'the needed access',
  },
};
