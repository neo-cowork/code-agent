// 「监听类」定时任务模板的展示文案（并入 cronCenter.templates，按模板 id 索引）。
// 单独成文件是为了让 cronCenter.ts 留在行数上限内。
export interface TemplateCopy {
  name: string;
  description: string;
  scheduleLabel: string;
  fields?: Record<string, { label: string; placeholder?: string }>;
}

export const watchTemplateCopyZh = {
  'web-change-watch': {
    name: '网页更新提醒',
    description: '关注竞品页面、政策页或公告页的变化',
    scheduleLabel: '每天 09:00（可调整）',
    fields: {
      url: { label: '网页地址', placeholder: '粘贴要关注的网页地址' },
      schedule: { label: '查看频率', placeholder: '例如：每天 9:00、每 2 小时' },
    },
  },
  'feishu-calendar-conflict': {
    name: '飞书日程冲突监听',
    description: '盯住某个飞书日历，出现时间冲突就提醒',
    scheduleLabel: '每天 09:00（可调整）',
    fields: {
      calendarId: { label: '日历 ID', placeholder: '飞书日历的 calendar_id（分享链接或调试台里取）' },
      schedule: { label: '查看频率', placeholder: '例如：每天 9:00、每 2 小时' },
    },
  },
  'feishu-table-change': {
    name: '飞书表格行变更监听',
    description: '盯住某张多维表格，有行新增或改动就提醒',
    scheduleLabel: '每天 09:00（可调整）',
    fields: {
      baseAppToken: { label: 'Base App Token', placeholder: '多维表格的 app_token' },
      tableId: { label: '数据表 ID', placeholder: 'table_id（tbl 开头）' },
      schedule: { label: '查看频率', placeholder: '例如：每天 9:00' },
    },
  },
  'group-listen': {
    name: '群监听',
    description: '盯住一个群，来了新消息就按你的一句话处理',
    scheduleLabel: '群里有新消息时',
    fields: {
      task: { label: '要做什么', placeholder: '例如：有人提到发布就总结给我' },
    },
  },
} satisfies Record<string, TemplateCopy>;

export const watchTemplateCopyEn = {
  'web-change-watch': {
    name: 'Web page change alerts',
    description: 'Watch a competitor, policy, or announcement page for changes',
    scheduleLabel: 'Daily at 09:00 (adjustable)',
    fields: {
      url: { label: 'Web page URL', placeholder: 'Paste the URL of the web page to watch' },
      schedule: { label: 'Check frequency', placeholder: 'For example: every day at 9:00, every 2 hours' },
    },
  },
  'feishu-calendar-conflict': {
    name: 'Feishu calendar conflict watch',
    description: 'Watch a Feishu calendar and alert on scheduling conflicts',
    scheduleLabel: 'Daily at 09:00 (adjustable)',
    fields: {
      calendarId: { label: 'Calendar ID', placeholder: 'Paste the Feishu calendar ID from its sharing link' },
      schedule: { label: 'Check frequency', placeholder: 'For example: every day at 9:00, every 2 hours' },
    },
  },
  'feishu-table-change': {
    name: 'Feishu table row change watch',
    description: 'Watch a Feishu Base table and alert when rows are added or changed',
    scheduleLabel: 'Daily at 09:00 (adjustable)',
    fields: {
      baseAppToken: { label: 'Base App Token', placeholder: 'Paste the app token of the Feishu Base' },
      tableId: { label: 'Table ID', placeholder: 'Paste the table ID (starts with tbl)' },
      schedule: { label: 'Check frequency', placeholder: 'For example: every day at 9:00' },
    },
  },
  'group-listen': {
    name: 'Group listen',
    description: 'Watch one group and handle new messages with your one-liner',
    scheduleLabel: 'When a new message arrives',
    fields: {
      task: { label: 'What should it do?', placeholder: 'For example: summarize messages that mention a release' },
    },
  },
} satisfies Record<string, TemplateCopy>;
