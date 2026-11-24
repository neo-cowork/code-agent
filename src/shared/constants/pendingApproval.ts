// 停车审批（pending_approvals）呈现常量（N-PARKED-APPROVAL-SURVIVE-RESTART-PERSIST）。

/**
 * 停车审批参数预览（argsPreview）脱敏后的截断上限。预览只要「一眼可辨这步要干什么」，
 * 完整入参不入库（库文件、收件箱渲染、SSE 事件三处都背着这份字符串，别放大）。
 */
export const PARKED_APPROVAL_PREVIEW_MAX_CHARS = 300;

/** 重启后被自动作废的停车审批，在自动化收件箱里保留这么久的灰色只读留痕（3 天）。 */
export const PARKED_APPROVAL_VOIDED_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/** Model instructions after an unattended outbound approval expires. */
export const OUTBOUND_APPROVAL_DEGRADE = {
  saved: {
    code: 'OUTBOUND_DRAFT_SAVED',
    feedback: {
      zh: '邮件未发送，草稿已放入 Agent Neo 自动化页的「等你」，等待用户确认发送。不要重试。在中文最终报告中向用户说明邮件尚未发送，草稿在 Agent Neo 的「等你」里。',
      en: 'The email was not sent. The draft is waiting in the Agent Neo automation review inbox for the user to press Send. Do not retry. Write the final report in English. Tell the user that the email was not sent and the draft is waiting for their confirmation in Agent Neo.',
    },
  },
  denied: {
    feedback: '外发未获批准，内容未发送。不要重试这一步；继续其他工作，并在最终报告里说明「未发送（需要你批准）」。',
  },
} as const;
