type Locale = 'zh' | 'en';

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
    failureDetails: Record<'not_authorized' | 'not_found' | 'unavailable' | 'read_failed', string>;
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
        read_failed: '请先查看日历，确认修改是否保存，再决定要不要重试。',
      },
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
        read_failed: 'Check Calendar to see whether the change was saved before retrying.',
      },
    },
  },
};

export function getHostConnectorCopy(locale: Locale): HostConnectorCopy {
  return copy[locale];
}
