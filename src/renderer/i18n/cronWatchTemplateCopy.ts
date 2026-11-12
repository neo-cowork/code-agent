// 「监听类」定时任务模板的展示文案（并入 cronCenter.templates，按模板 id 索引）。
// 单独成文件是为了让 cronCenter.ts 留在行数上限内。
interface TemplateCopy { name: string; description: string; scheduleLabel: string }

export const watchTemplateCopyZh: Record<string, TemplateCopy> = {
  'web-change-watch': {
    name: '网页更新提醒',
    description: '关注竞品页面、政策页或公告页的变化',
    scheduleLabel: '每天 09:00（可调整）',
  },
  'feishu-calendar-conflict': {
    name: '飞书日程冲突监听',
    description: '盯住某个飞书日历，出现时间冲突就提醒',
    scheduleLabel: '每天 09:00（可调整）',
  },
  'feishu-table-change': {
    name: '飞书表格行变更监听',
    description: '盯住某张多维表格，有行新增或改动就提醒',
    scheduleLabel: '每天 09:00（可调整）',
  },
};

export const watchTemplateCopyEn: Record<string, TemplateCopy> = {
  'web-change-watch': {
    name: 'Web page change alerts',
    description: 'Watch a competitor, policy, or announcement page for changes',
    scheduleLabel: 'Daily at 09:00 (adjustable)',
  },
  'feishu-calendar-conflict': {
    name: 'Feishu calendar conflict watch',
    description: 'Watch a Feishu calendar and alert on scheduling conflicts',
    scheduleLabel: 'Daily at 09:00 (adjustable)',
  },
  'feishu-table-change': {
    name: 'Feishu table row change watch',
    description: 'Watch a Feishu Base table and alert when rows are added or changed',
    scheduleLabel: 'Daily at 09:00 (adjustable)',
  },
};
