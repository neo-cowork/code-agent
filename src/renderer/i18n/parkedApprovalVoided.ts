import { toolUserLabel } from '@shared/utils/toolUserLabel';

// Read-only inbox history copy; tool keys match the registered host tool names.
export const parkedApprovalVoidedZh = {
  restartPrefix: '重启前发起 · ',
  startedAt: '开始于 {time}',
  summary: '{count} 条已作废的审批，没有执行',
  expand: '展开',
  collapse: '收起',
  action: '一项操作',
  tools: {
    bash: toolUserLabel('bash', 'zh'), write: toolUserLabel('write', 'zh'), edit: toolUserLabel('edit', 'zh'), read: toolUserLabel('read', 'zh'),
    glob: toolUserLabel('glob', 'zh'), grep: toolUserLabel('grep', 'zh'), listdirectory: '查看目录',
    webfetch: toolUserLabel('webfetch', 'zh'), websearch: toolUserLabel('websearch', 'zh'),
    mail_send: '发送邮件', mail_draft: '起草邮件', mail: '邮件操作',
  },
};

export const parkedApprovalVoidedEn = {
  restartPrefix: 'Started before restart · ',
  startedAt: 'Started {time}',
  summary: '{count} approvals were voided and did not run',
  expand: 'Expand',
  collapse: 'Collapse',
  action: 'An action',
  tools: {
    bash: toolUserLabel('bash', 'en'), write: toolUserLabel('write', 'en'), edit: toolUserLabel('edit', 'en'), read: toolUserLabel('read', 'en'),
    glob: toolUserLabel('glob', 'en'), grep: toolUserLabel('grep', 'en'), listdirectory: 'View a folder',
    webfetch: toolUserLabel('webfetch', 'en'), websearch: toolUserLabel('websearch', 'en'),
    mail_send: 'Send an email', mail_draft: 'Draft an email', mail: 'Email action',
  },
};
