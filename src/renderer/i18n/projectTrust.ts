// ============================================================================
// ProjectTrust 词条（N-FIX-SIGNED-OUT-SEND-500-RAW-HTML-REDESIGN）
// ============================================================================
// chatTranscript.ts 已贴 max-lines 棘轮上限，本单新增的 turnRun/turnCard 键放这个
// 小模块里，由 chatTranscript 在对应块内 spread 进去（zh/en 相邻维护、键集对称）：
//   turnRun.replyGenerated / awaitingOutput —— TurnCard 轮头阶段兜底（原硬编码中文）；
//   turnCard.projectTrustConfirm —— 旧项目 Source 快照缺失时失败气泡上的
//   「确认并重发」入口与确认失败句。
// ============================================================================

export const projectTrustTurnRunZh = {
  replyGenerated: '回复已生成',
  awaitingOutput: '等待输出',
};

export const projectTrustTurnRunEn = {
  replyGenerated: 'Reply generated',
  awaitingOutput: 'Awaiting output',
};

// 「会话被旧任务占着」失败说明点名的两个按钮标签：说明句（httpFailureMessage）与卡片按钮
// 共用这一份，保证句子点名的控件和实际渲染的控件是同一组。
export const sessionConflictLabels: Record<'zh' | 'en', { abandon: string; retry: string }> = {
  zh: { abandon: '放弃', retry: '重试' },
  en: { abandon: 'Abandon', retry: 'Retry' },
};

export const projectTrustTurnCardZh = {
  sessionConflict: {
    abandon: sessionConflictLabels.zh.abandon,
    retry: sessionConflictLabels.zh.retry,
    abandoned: '旧任务已结束，可以点「重试」了。',
    abandonFailed: '没能结束旧任务，请稍后再试。',
  },
  projectTrustConfirm: {
    button: '确认并重发',
    failed: 'Neo 暂时没能完成这次请求，请稍后再试。',
  },
};

export const projectTrustTurnCardEn = {
  sessionConflict: {
    abandon: sessionConflictLabels.en.abandon,
    retry: sessionConflictLabels.en.retry,
    abandoned: 'The earlier task has ended. You can retry now.',
    abandonFailed: 'Could not end the earlier task. Try again in a moment.',
  },
  projectTrustConfirm: {
    button: 'Confirm and resend',
    failed: 'Neo could not complete the request; please try again in a moment.',
  },
};
