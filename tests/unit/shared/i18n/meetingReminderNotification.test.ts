// 会前提醒系统通知文案走 i18n（#3426 ai-review Nit②：原来写死中文、兜底「日历上的会」）。
import { describe, expect, it } from 'vitest';
import { getMeetingReminderNotificationText } from '../../../../src/shared/i18n/meetingReminderNotification';

describe('meeting reminder notification copy', () => {
  it('follows the UI language and falls back to an untitled meeting in the same language', () => {
    expect(getMeetingReminderNotificationText('zh', '产品评审').title).toBe('「产品评审」快开始了');
    expect(getMeetingReminderNotificationText('zh', '  ').title).toBe('「日历上的会」快开始了');
    const en = getMeetingReminderNotificationText('en', '');
    expect(en.title).toBe('"A meeting on your calendar" is starting soon');
    expect(en.body).toContain('Record this meeting');
    expect(en.body).not.toMatch(/[一-鿿]/);
  });
});
