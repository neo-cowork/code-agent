// ============================================================================
// 会前提醒系统通知文案（zh/en，N-MEETING-CALENDAR-REMINDER）
// locale 由通知服务从 configService 的 ui.language 读入（与 durableResumeNotification 同一机制）。
// ============================================================================
export type MeetingReminderNotificationLocale = 'zh' | 'en';

const messages: Record<MeetingReminderNotificationLocale, { untitled: string; title: (t: string) => string; body: string }> = {
  zh: {
    untitled: '日历上的会',
    title: (t) => `「${t}」快开始了`,
    body: '要记这场会吗？打开 Neo，在输入框上方点「记这场会」。记得先征得参会人同意。',
  },
  en: {
    untitled: 'A meeting on your calendar',
    title: (t) => `"${t}" is starting soon`,
    body: 'Want to record it? Open Neo and click "Record this meeting" above the input box. Ask attendees for consent first.',
  },
};

export function getMeetingReminderNotificationText(
  locale: MeetingReminderNotificationLocale,
  meetingTitle: string,
): { title: string; body: string } {
  const m = messages[locale];
  return { title: m.title(meetingTitle.trim() || m.untitled), body: m.body };
}
