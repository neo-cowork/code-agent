// ============================================================================
// 专家定时唤醒在自动化面板里的呈现文案（N-FIX-ROLE-WAKE-CADENCE-NO-RECORD）。
// 单独成文件：cronCenter.ts / zhSettingsWork.ts 已在行数上限。
// ============================================================================

interface CronWakeCadenceCopy {
  decision: { advance: string; report: string; suggest: string; silence: string };
  decisionTitle: string;
  skipGeneric: string;
  skippedBadge: string;
  connectorLost: string;
}

export const cronWakeCadenceZh: { cronWakeCadence: CronWakeCadenceCopy } = {
  cronWakeCadence: {
    decision: { advance: '推进', report: '汇报', suggest: '建议', silence: '沉默' },
    decisionTitle: '本次醒来的决定',
    skipGeneric: '未运行：本次醒来被跳过',
    skippedBadge: '未运行',
    connectorLost: '未运行：{names}已退出登录，重新连接后会继续',
  },
};

export const cronWakeCadenceEn: { cronWakeCadence: CronWakeCadenceCopy } = {
  cronWakeCadence: {
    decision: { advance: 'Advanced', report: 'Reported', suggest: 'Suggested', silence: 'Stayed silent' },
    decisionTitle: 'What it decided this time',
    skipGeneric: 'Not run: this wake was skipped',
    skippedBadge: 'Not run',
    connectorLost: 'Not run: {names} signed out — it will resume after you reconnect',
  },
};
