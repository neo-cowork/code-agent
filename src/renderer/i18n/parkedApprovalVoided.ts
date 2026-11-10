// Read-only inbox history copy; tool keys match the registered host tool names.
export const parkedApprovalVoidedZh = {
  restartPrefix: '重启前发起 · ',
  summary: '{count} 条已作废的审批，没有执行',
  expand: '展开',
  collapse: '收起',
  action: '一项操作',
  tools: {
    bash: '运行命令', write: '写入文件', edit: '编辑文件', read: '读取文件',
    glob: '查找文件', grep: '搜索内容', listdirectory: '查看目录',
    webfetch: '读取网页', websearch: '搜索网页',
    mail_send: '发送邮件', mail_draft: '起草邮件', mail: '邮件操作',
  },
};

export const parkedApprovalVoidedEn = {
  restartPrefix: 'Started before restart · ',
  summary: '{count} approvals were voided and did not run',
  expand: 'Expand',
  collapse: 'Collapse',
  action: 'An action',
  tools: {
    bash: 'Run a command', write: 'Write a file', edit: 'Edit a file', read: 'Read a file',
    glob: 'Find files', grep: 'Search content', listdirectory: 'View a folder',
    webfetch: 'Read a webpage', websearch: 'Search the web',
    mail_send: 'Send an email', mail_draft: 'Draft an email', mail: 'Email action',
  },
};
