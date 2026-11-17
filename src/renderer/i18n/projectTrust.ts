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
    reselect: '重新选择文件夹',
    folder: '此文件夹',
    reasons: {
      source_missing: '找不到项目文件夹“{name}”。它可能已被移动或删除。',
      identity_changed: '项目文件夹“{name}”已被替换，请重新选择并确认。',
      not_trusted: '此项目文件夹尚未获得信任，请在项目设置中确认。',
      folder_trust_blocked: '此文件夹已被禁止访问，请在文件夹信任设置中检查。',
      folder_trust_review_required: '此文件夹有需要你审阅的配置，请先完成文件夹信任审阅。',
      folder_trust_record_failed: '未能保存文件夹信任记录，请重新确认。',
      update_rejected: '项目设置已发生变化，请检查最新设置后重新确认。',
      verification_failed: '未能核实项目文件夹，请检查文件夹后重新确认。',
      project_not_found: '此项目已不存在，请选择其他项目。',
      nothing_to_confirm: '此项目没有需要确认的文件夹，请检查项目设置。',
    },

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
    reselect: 'Re-select folder',
    folder: 'this folder',
    reasons: {
      source_missing: 'Cannot find project folder “{name}”. It may have been moved or deleted.',
      identity_changed: 'Project folder “{name}” has been replaced. Re-select and confirm it.',
      not_trusted: 'This project folder is not trusted. Confirm it in project settings.',
      folder_trust_blocked: 'Access to this folder has been blocked. Check folder trust settings.',
      folder_trust_review_required: 'This folder has settings that need your review. Complete the folder trust review first.',
      folder_trust_record_failed: 'Could not save the folder trust decision. Please confirm it again.',
      update_rejected: 'Project settings have changed. Check the latest settings and confirm again.',
      verification_failed: 'Could not verify the project folder. Check the folder and confirm again.',
      project_not_found: 'This project no longer exists. Choose another project.',
      nothing_to_confirm: 'This project has no folders to confirm. Check project settings.',
    },

    failed: 'Neo could not complete the request; please try again in a moment.',
  },
};
