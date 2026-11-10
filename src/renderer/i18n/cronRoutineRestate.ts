// Shared cron editor restatement and urgency-rule copy.
export const cronRoutineRestateZh = {
  savedRestateTitle: '已保存 · 这个自动化会这样做',
  savedRestateDone: '完成',
  savedRestateWhenEvent: '有新消息到达时',
  savedRestateRolePrefix: '由 {role} 执行：',
  // 停用副本的第四行「状态」（N-ROLE-ROUTINE-RESTATE-FU1-FU1）
  savedRestateStatusLabel: '状态',
  savedRestateStatusPaused: '当前已停用，点启用后才会按时跑',
  // 保存前确认卡（N-CRON-MORNING-TRIAGE-REST1）：无角色任务先复述再落库；
  // 行文案复用 chatInput 的 scheduleConfirm（what/when/notifyWhen/result）
  pendingRestateTitle: '保存前确认 · 这个自动化会这样做',
  pendingRestateHint: '现在还没有创建任何任务，核对无误再保存；想改就返回。',
  pendingRestateHintUpdate: '改动还没有保存，核对无误再确认；想改就返回。',
  pendingRestateConfirm: '确认保存',
  pendingRestateBack: '返回修改',
  // 手动编辑器 Agent 动作：自定义紧急判据（N-CRON-MORNING-TRIAGE-URGENCY-RULE）
  urgencyCriteriaLabel: '紧急判据（可选）',
  urgencyCriteriaPlaceholder: '例如：只有老板发来的邮件算今天必须处理',
  urgencyCriteriaHint: '设置后，非今日必办（可以稍后 / 仅供参考）的运行不再弹通知，安静等在待过目列表里。',
};

export const cronRoutineRestateEn = {
  savedRestateTitle: 'Saved · what this automation will do',
  savedRestateDone: 'Done',
  savedRestateWhenEvent: 'When a new message arrives',
  savedRestateRolePrefix: 'Run by {role}: ',
  savedRestateStatusLabel: 'Status',
  savedRestateStatusPaused: 'Currently paused — it will only run on schedule after you turn it on.',
  pendingRestateTitle: 'Before saving · what this automation will do',
  pendingRestateHint: 'Nothing is created yet — check it over, then save. Or go back and edit.',
  pendingRestateHintUpdate: 'Your changes are not saved yet — check them, then confirm. Or go back and edit.',
  pendingRestateConfirm: 'Save it',
  pendingRestateBack: 'Back to edit',
  urgencyCriteriaLabel: 'Urgency rule (optional)',
  urgencyCriteriaPlaceholder: 'e.g. only mail from my boss counts as must-do today',
  urgencyCriteriaHint: 'With a rule set, non-urgent runs (can wait / FYI) skip notifications and wait quietly in the review list.',
};
