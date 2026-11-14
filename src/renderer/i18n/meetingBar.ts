// ============================================================================
// 「记这场会」录制条与会前提醒开关的词条（N-MEETING-SESSION）—— zh/en 同文件相邻维护。
// 独立文件避免 chatInput.ts 撞 max-lines(1000) 门。插值约定：'{key}' 占位符 + String.replace。
// ============================================================================
export const meetingBarZh = {
  meetingBar: {
    recording: '记录中',
    paused: '已暂停',
    pause: '暂停',
    resume: '继续',
    stop: '结束',
    silenceWarning: '已经 {minutes} 分钟没人说话，{remain} 分钟后自动结束',
    ended: {
      manual: '这场会已结束',
      silence: '{minutes} 分钟没人说话，这场会已自动结束',
      max_duration: '已录满 {hours} 小时，这场会已自动结束',
      sleep: '电脑睡眠了，这场会已结束',
      capture_stopped: '录音停了，这场会已结束',
      interrupted: '上次 Neo 退出时这场会被中断',
    },
    startFailed: '录音没开起来',
    openSettings: '去设置看看',
    dismiss: '知道了',
    upcoming: '「{title}」快开始了',
    upcomingStart: '记这场会',
    upcomingConsent: '先征得参会人同意',
    calendarToggleLabel: '会前提醒我记这场会',
    calendarToggleHint: '日历上的会快开始时提醒你，只提醒，不会自动录音。打开时会请求读取日历。',
    calendarDenied: '没拿到日历权限。去「系统设置 → 隐私与安全性 → 日历」里允许 Agent Neo，再打开这里。',
  },
};

export const meetingBarEn: typeof meetingBarZh = {
  meetingBar: {
    recording: 'Recording',
    paused: 'Paused',
    pause: 'Pause',
    resume: 'Resume',
    stop: 'End',
    silenceWarning: 'No one has spoken for {minutes} min — ending automatically in {remain} min',
    ended: {
      manual: 'This meeting has ended',
      silence: 'No one spoke for {minutes} min, so the meeting was ended',
      max_duration: 'Reached the {hours}-hour limit, so the meeting was ended',
      sleep: 'Your computer went to sleep, so the meeting was ended',
      capture_stopped: 'Recording stopped, so the meeting was ended',
      interrupted: 'This meeting was interrupted when Neo last quit',
    },
    startFailed: "Recording didn't start",
    openSettings: 'Check settings',
    dismiss: 'Got it',
    upcoming: '"{title}" is about to start',
    upcomingStart: 'Record this meeting',
    upcomingConsent: 'Ask everyone for consent first',
    calendarToggleLabel: 'Remind me to record meetings',
    calendarToggleHint: "Reminds you when a calendar meeting is about to start. It only reminds — it never records on its own. Turning this on asks to read your calendar.",
    calendarDenied: 'Calendar access was not granted. Allow Agent Neo in System Settings → Privacy & Security → Calendars, then turn this on again.',
  },
};
