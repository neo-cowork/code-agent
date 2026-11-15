// ============================================================================
// 会议设置与会议页词条（N-MEETING-PAGE）。独立文件：zh/enSettingsWork 已贴 max-lines 天花板。
// ============================================================================

export const zhSettingsMeeting = {
  meeting: {
    autoMinutes: {
      toggleLabel: '散会后自动出纪要',
      hintOn: '每场会结束后交给「记言」整理决策、行动项和未解问题，每场调用一次模型、会产生费用；转写太短的会不出。',
      hintOff: '已关闭：会议结束后不自动出纪要。',
      saveFailed: '保存失败，请重试',
    },
  },
};

export const enSettingsMeeting = {
  meeting: {
    autoMinutes: {
      toggleLabel: 'Write minutes after each meeting',
      hintOn: 'When a meeting ends, the minutes assistant lists its decisions, action items and open questions. Each meeting costs one model run; very short transcripts are skipped.',
      hintOff: 'Off: no minutes are written automatically when a meeting ends.',
      saveFailed: 'Could not save. Please try again.',
    },
  },
};
