type Locale = 'zh' | 'en';

export type CalendarFailureCopyKey =
  | 'not_authorized' | 'not_found' | 'unavailable' | 'read_failed'
  | 'write_unconfirmed' | 'end_before_start' | 'end_must_follow_start'
  | 'no_writable_calendar' | 'calendar_name_not_found'
  | 'missing_title' | 'missing_start' | 'missing_update' | 'missing_start_for_end';

type ReadReceiptCopy = {
  collections: string;
  items: string;
  emptyCollections: string;
  emptyItems: string;
  status: string;
};

type HostConnectorCopy = {
  separator: string;
  noSubject: string;
  now: (time: string, zone: string) => string;
  appleScriptFailure: {
    not_authorized: string;
    not_found: string;
    timeout: string;
    read_failed: string;
  };
  mail: {
    sent: string;
    drafted: string;
    sendFailed: string;
    draftFailed: string;
    status: string;
    saved: string;
    unsaved: string;
  };
  reminders: {
    created: string;
    updated: string;
    deleted: string;
    createFailed: string;
    updateFailed: string;
    deleteFailed: string;
    time: string;
    notes: string;
    notSet: string;
    unknownTime: string;
    noTime: string;
    dueLater: string;
    overdue: string;
    days: readonly string[];
    timeContext: (time: string, context: string[]) => string;
    unconfirmed: string;
    read: ReadReceiptCopy;
  };
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
    unknownStart: string;
    unknownEnd: string;
    read: ReadReceiptCopy;
  };
};

const copy: Record<Locale, HostConnectorCopy> = {
  zh: {
    separator: '：',
    noSubject: '(无主题)',
    now: (time, zone) => `现在：${time}；时区：${zone}。以下时间均按该时区显示。`,
    appleScriptFailure: {
      not_authorized: '请在系统设置中允许 Neo 访问此应用。',
      not_found: '找不到所需的项目。',
      timeout: '应用没有及时确认操作。请先查看应用，再决定是否重试。',
      read_failed: '应用未能完成此操作。',
    },
    mail: {
      sent: '已发送邮件',
      drafted: '已创建邮件草稿',
      sendFailed: '发送邮件失败',
      draftFailed: '创建邮件草稿失败',
      status: '状态',
      saved: '已保存到草稿',
      unsaved: '未保存',
    },
    reminders: {
      created: '已创建提醒',
      updated: '已更新提醒',
      deleted: '已删除提醒',
      createFailed: '创建提醒失败',
      updateFailed: '更新提醒失败',
      deleteFailed: '删除提醒失败',
      time: '提醒时间',
      notes: '备注',
      notSet: '未设置',
      unknownTime: '无法确认，请在提醒事项中查看',
      noTime: '无提醒时间',
      dueLater: '（未到点）',
      overdue: '（已过点）',
      days: ['今天', '明天', '后天'],
      timeContext: (time, context) => `${time}（${context.join('，')}）`,
      unconfirmed: '请先查看提醒事项，确认提醒是否已保存，再决定是否重试。',
      read: {
        collections: '可用提醒列表',
        items: '提醒事项',
        emptyCollections: '没有找到可访问的提醒列表。',
        emptyItems: '没有找到匹配的提醒。',
        status: '提醒事项状态',
      },
    },
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
      unknownStart: '未知开始时间',
      unknownEnd: '未知结束时间',
      read: {
        collections: '可用日历',
        items: '日历事件',
        emptyCollections: '没有找到可访问的日历。',
        emptyItems: '没有找到匹配的日历事件。',
        status: '日历状态',
      },
    },
  },
  en: {
    separator: ': ',
    noSubject: '(no subject)',
    now: (time, zone) => `Now: ${time}. Time zone: ${zone}. Times below use this time zone.`,
    appleScriptFailure: {
      not_authorized: 'Allow Neo to access this app in System Settings.',
      not_found: 'The requested item could not be found.',
      timeout: 'The app did not confirm the action. Check the app before retrying.',
      read_failed: 'The app could not complete the request.',
    },
    mail: {
      sent: 'Email sent',
      drafted: 'Email draft created',
      sendFailed: 'Could not send email',
      draftFailed: 'Could not create email draft',
      status: 'Status',
      saved: 'Saved to Drafts',
      unsaved: 'Unsaved',
    },
    reminders: {
      created: 'Reminder created',
      updated: 'Reminder updated',
      deleted: 'Reminder deleted',
      createFailed: 'Could not create reminder',
      updateFailed: 'Could not update reminder',
      deleteFailed: 'Could not delete reminder',
      time: 'Reminder time',
      notes: 'Notes',
      notSet: 'Not set',
      unknownTime: 'Time could not be confirmed. Check Reminders.',
      noTime: 'No reminder time',
      dueLater: ' (due later)',
      overdue: ' (past due)',
      days: ['Today', 'Tomorrow', 'Day after tomorrow'],
      timeContext: (time, context) => `${time} (${context.join(', ')})`,
      unconfirmed: 'Check Reminders to see whether the reminder was saved before retrying.',
      read: {
        collections: 'Available reminder lists',
        items: 'Reminders',
        emptyCollections: 'No accessible reminder lists found.',
        emptyItems: 'No matching reminders found.',
        status: 'Reminders status',
      },
    },
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
      unknownStart: 'Unknown start time',
      unknownEnd: 'Unknown end time',
      read: {
        collections: 'Available calendars',
        items: 'Calendar events',
        emptyCollections: 'No accessible calendars found.',
        emptyItems: 'No matching calendar events found.',
        status: 'Calendar status',
      },
    },
  },
};

export function getHostConnectorCopy(locale: Locale): HostConnectorCopy {
  return copy[locale];
}
