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

export const projectTrustTurnCardZh = {
  projectTrustConfirm: {
    button: '确认并重发',
    failed: 'Neo 暂时没能完成这次请求，请稍后再试。',
  },
};

export const projectTrustTurnCardEn = {
  projectTrustConfirm: {
    button: 'Confirm and resend',
    failed: 'Neo could not complete the request; please try again in a moment.',
  },
};
