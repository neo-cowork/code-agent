const CONNECTOR_ENTRY_ZH = '能力中心 > 连接器';

export const CONNECTOR_RECONNECT_ZH = {
  reconnect: `这次还没读到所需数据，请在${CONNECTOR_ENTRY_ZH}重新连接后再试。`,
  remindersUnchecked: `还没检查提醒事项的访问权限，请在${CONNECTOR_ENTRY_ZH}点‘检查’并按提示授权。`,
  remindersDenied: `还没有授权 Neo 访问提醒事项，请在${CONNECTOR_ENTRY_ZH}点‘检查’并按提示授权。`,
  calendar: `日历还没有连接，所以这次看不到你的日程，请在${CONNECTOR_ENTRY_ZH}打开后再试。`,
  mail: `邮件还没有连接，所以这次看不到你的邮件，请在${CONNECTOR_ENTRY_ZH}打开后再试。`,
  reminders: `提醒事项还没有连接，所以这次看不到你的提醒事项，请在${CONNECTOR_ENTRY_ZH}打开后再试。`,
} as const;
