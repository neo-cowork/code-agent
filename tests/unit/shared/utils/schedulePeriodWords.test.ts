import { describe, it, expect } from 'vitest';
import { readExplicitDailySchedule } from '../../../../src/shared/utils/schedulePeriodWords';

describe('readExplicitDailySchedule fail-closed', () => {
  it.each([
    '每天早上 2.5 小时整理收件箱',
    '每天早上 3.5 分钟看邮件',
    '每天早上 1 刻钟看邮件',
    '每天早上 10 分钟看邮件',
    '每天早上 2 个小时整理',
    '每天早上 2 钟头整理',
    '每天晚上 8 点汇总。改成每天早上 2.5 小时整理收件箱',
    '每天早上 9 点检查邮箱。改成每天早上 10 分钟看邮件',
    '每天早上 9 点。改成每天晚上 8 点。改成只看标题',
    '每天早上 9 点 10 分钟巡检',
    'every morning 2.5 hours inbox',
    'every morning 10 minutes of mail',
    '每晚 3 分钟',
    '帮我看邮件',
  ])('returns null/undefined (silent) for %s', (text) => {
    expect(readExplicitDailySchedule(text) ?? null).toBeNull();
  });

  it.each([
    ['每天早上 9 点', '09:00'],
    ['每天早上 9 点半', '09:30'],
    ['每天早上 9:15', '09:15'],
    ['每天早上 9 点 15 分', '09:15'],
    ['每天早上 9 时', '09:00'],
    ['every day at 9 o\'clock', '09:00'],
    ['每天早上 9 点检查邮箱。改成每天晚上 8 点', '20:00'],
    ['每天晚上零点汇总', '00:00'],
    ['创建「每晚 3 分钟」。每天早上 9 点查看日历', '09:00'],
    ['每晚 7', '19:00'],
    ['每早8', '08:00'],
  ])('reads %s as %s', (text, time) => {
    expect(readExplicitDailySchedule(text)).toBe(time);
  });
});
