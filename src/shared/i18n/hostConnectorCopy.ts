type Locale = 'zh' | 'en';

export type CalendarFailureCopyKey =
  | 'not_authorized' | 'not_found' | 'unavailable' | 'read_failed'
  | 'write_unconfirmed' | 'end_before_start' | 'end_must_follow_start'
  | 'no_writable_calendar' | 'calendar_name_not_found'
  | 'missing_title' | 'missing_start' | 'missing_update' | 'missing_start_for_end';

type HostConnectorCopy = {
  separator: string;
  noSubject: string;
  approvals: Record<
    | 'mail_send' | 'mail_draft'
    | 'calendar_create_event' | 'calendar_update_event' | 'calendar_delete_event'
    | 'reminders_create' | 'reminders_update' | 'reminders_delete',
    string
  >;
  calendar: {
    created: string;
    updated: string;
    deleted: string;
    createFailed: string;
    updateFailed: string;
    deleteFailed: string;
    unknown: string;
    start: string;
    end: string;
    location: string;
    notes: string;
    withTime: (title: string, time: string) => string;
    failureDetails: Record<CalendarFailureCopyKey, string>;
    availableCalendars: string;
  };
};

const copy: Record<Locale, HostConnectorCopy> = {
  zh: {
    separator: '：',
    noSubject: '(无主题)',
    approvals: {
      mail_send: '发送邮件',
      mail_draft: '创建邮件草稿',
      calendar_create_event: '创建日历事件',
      calendar_update_event: '更新日历事件',
      calendar_delete_event: '删除日历事件',
      reminders_create: '创建提醒',
      reminders_update: '更新提醒',
      reminders_delete: '删除提醒',
    },
    calendar: {
      created: '已创建日历事件',
      updated: '已更新日历事件',
      deleted: '已删除日历事件',
      createFailed: '创建日历事件失败',
      updateFailed: '更新日历事件失败',
      deleteFailed: '删除日历事件失败',
      unknown: '未知',
      start: '开始',
      end: '结束',
      location: '地点',
      notes: '备注',
      withTime: (title, time) => `${title}（${time}）`,
      failureDetails: {
        not_authorized: 'Neo 需要访问日历的权限。',
        not_found: '找不到对应的日程或日历。',
        unavailable: '请在 macOS 的 Neo 桌面应用中使用日历。',
        read_failed: '暂时无法完成日历操作。',
        write_unconfirmed: '请先查看日历，确认修改是否保存，再决定要不要重试。',
        end_before_start: '结束时间不能早于开始时间。',
        end_must_follow_start: '结束时间必须晚于开始时间。日程没有被修改。',
        no_writable_calendar: '找不到可以添加日程的日历。',
        calendar_name_not_found: '找不到指定的日历。',
        missing_title: '请填写日程标题。',
        missing_start: '请填写开始时间。',
        missing_update: '请指定要修改的内容。',
        missing_start_for_end: '修改结束时间时，请同时填写开始时间。',
      },
      availableCalendars: '可选日历',
    },
  },
  en: {
    separator: ': ',
    noSubject: '(no subject)',
    approvals: {
      mail_send: 'Send email',
      mail_draft: 'Create email draft',
      calendar_create_event: 'Create calendar event',
      calendar_update_event: 'Update calendar event',
      calendar_delete_event: 'Delete calendar event',
      reminders_create: 'Create reminder',
      reminders_update: 'Update reminder',
      reminders_delete: 'Delete reminder',
    },
    calendar: {
      created: 'Calendar event created',
      updated: 'Calendar event updated',
      deleted: 'Calendar event deleted',
      createFailed: 'Could not create calendar event',
      updateFailed: 'Could not update calendar event',
      deleteFailed: 'Could not delete calendar event',
      unknown: 'Unknown',
      start: 'Start',
      end: 'End',
      location: 'Location',
      notes: 'Notes',
      withTime: (title, time) => `${title} (${time})`,
      failureDetails: {
        not_authorized: 'Neo needs permission to access Calendar.',
        not_found: 'The event or calendar could not be found.',
        unavailable: 'Calendar is available in the Neo desktop app on macOS.',
        read_failed: 'Calendar could not complete the request.',
        write_unconfirmed: 'Check Calendar to see whether the change was saved before retrying.',
        end_before_start: 'The end time cannot be earlier than the start time.',
        end_must_follow_start: 'The end time must be later than the start time. The event was left as it was.',
        no_writable_calendar: 'There are no calendars where Neo can add an event.',
        calendar_name_not_found: 'The specified calendar could not be found.',
        missing_title: 'Enter a title for the event.',
        missing_start: 'Enter a start time for the event.',
        missing_update: 'Specify what to change about the event.',
        missing_start_for_end: 'Provide a start time when changing the end time.',
      },
      availableCalendars: 'Available calendars',
    },
  },
};

export function getHostConnectorCopy(locale: Locale): HostConnectorCopy {
  return copy[locale];
}
