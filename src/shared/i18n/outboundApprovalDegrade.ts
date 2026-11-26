// 无人值守外发审批过期后回给模型的说明（语言包，放 i18n/ 目录以免被 CJK 棘轮当成硬编码）。
// 文本原样迁自 shared/constants/pendingApproval.ts；OUTBOUND_APPROVAL_DEGRADE 的形状与导出名不变。
export const OUTBOUND_APPROVAL_DEGRADE_FEEDBACK = {
  saved: {
    zh: '邮件未发送，草稿已放入 Agent Neo 自动化页的「等你」，等待用户确认发送。不要重试。在中文最终报告中向用户说明邮件尚未发送，草稿在 Agent Neo 的「等你」里。',
    en: 'The email was not sent. The draft is waiting in the Agent Neo automation review inbox for the user to press Send. Do not retry. Write the final report in English. Tell the user that the email was not sent and the draft is waiting for their confirmation in Agent Neo.',
  },
  denied: '外发未获批准，内容未发送。不要重试这一步；继续其他工作，并在最终报告里说明「未发送（需要你批准）」。',
} as const;
