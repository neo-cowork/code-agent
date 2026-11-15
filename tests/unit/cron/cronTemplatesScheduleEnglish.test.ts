import { describe, expect, it } from 'vitest';
import { CRON_TEMPLATES } from '../../../src/renderer/components/features/cron/cronTemplates';

const templates = CRON_TEMPLATES.filter((t) => ['web-change-watch', 'feishu-calendar-conflict', 'feishu-table-change'].includes(t.id));
const daily = (cronExpression: string) => ({ scheduleType: 'cron', cronExpression, cronTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
const every = (everyInterval: string, everyUnit: string) => ({ scheduleType: 'every', everyInterval, everyUnit });

const cases = [
  ['every 2 hours', every('2', 'hours')],
  ['every hour', every('1', 'hours')],
  ['EVERY 3 HOURS', every('3', 'hours')],
  ['every 15 minutes', every('15', 'minutes')],
  ['Every 1 Minute', every('1', 'minutes')],
  ['every day at 9:30', daily('30 9 * * *')],
  ['every day 9:30', daily('30 9 * * *')],
  ['every day at 9', daily('0 9 * * *')],
  ['every day 8', daily('0 8 * * *')],
  ['daily at 16:45', daily('45 16 * * *')],
  ['daily 16:45', daily('45 16 * * *')],
  ['DAILY AT 7', daily('0 7 * * *')],
  ['  daily 07  ', daily('0 7 * * *')],
  ['每 2 小时', every('2', 'hours')],
  ['每小时', every('1', 'hours')],
  ['每 15 分钟', every('15', 'minutes')],
  ['每分钟', every('5', 'minutes')],
  ['每天 9:30', daily('30 9 * * *')],
  ['每天', daily('0 9 * * *')],
  ['30 8 * * 1-5', daily('30 8 * * 1-5')],
  ['0 30 8 * * 1-5', daily('0 30 8 * * 1-5')],
  ['garbage text', daily('0 9 * * *')],
  ['', daily('0 9 * * *')],
  ['daily at 24:99', daily('0 9 * * *')],
] as const;

describe.each(templates)('$id public generate schedule parsing', (template) => {
  it.each(cases)('%s creates the promised schedule', (schedule, expected) => {
    const draft = template.generate({ url: 'https://example.com/releases', calendarId: 'calendar', baseAppToken: 'base', tableId: 'tbl_updates', schedule }, 'en');
    expect(draft).toMatchObject(expected);
    console.log(`${template.id} generate(${JSON.stringify(schedule)}) => ${JSON.stringify(expected)}`);
  });
});
