const CONNECTOR_ENTRY_ZH = '能力中心 > 连接器';

export const CONNECTOR_RECONNECT_ZH = {
  reconnect: `这次还没读到所需数据，请在${CONNECTOR_ENTRY_ZH}重新连接后再试。`,
  remindersUnchecked: `还没检查提醒事项的访问权限，请在${CONNECTOR_ENTRY_ZH}点‘检查’并按提示授权。`,
  remindersDenied: `还没有授权 Neo 访问提醒事项，请在${CONNECTOR_ENTRY_ZH}点‘检查’并按提示授权。`,
  calendar: `日历还没有连接，所以这次看不到你的日程，请在${CONNECTOR_ENTRY_ZH}打开后再试。`,
  mail: `邮件还没有连接，所以这次看不到你的邮件，请在${CONNECTOR_ENTRY_ZH}打开后再试。`,
  reminders: `提醒事项还没有连接，所以这次看不到你的提醒事项，请在${CONNECTOR_ENTRY_ZH}打开后再试。`,
} as const;

export const CONNECTOR_EXIT_PREFIX = 'The complete user-facing answer is exactly this single everyday sentence: “';

const CONNECTOR_RECONNECT_EN: Record<keyof typeof CONNECTOR_RECONNECT_ZH, string> = {
  reconnect: 'I could not retrieve the data. Reconnect in Capability Hub > Connectors and try again.',
  remindersUnchecked: 'Neo has not checked access to Reminders. Select Check in Capability Hub > Connectors and follow the prompts.',
  remindersDenied: 'Neo needs permission to access Reminders. Select Check in Capability Hub > Connectors and follow the prompts.',
  calendar: 'Calendar is disconnected, so I could not see your events. Connect it in Capability Hub > Connectors and try again.',
  mail: 'Mail is disconnected, so I could not see your emails. Connect it in Capability Hub > Connectors and try again.',
  reminders: 'Reminders is disconnected, so I could not see your reminders. Connect it in Capability Hub > Connectors and try again.',
};

export function getConnectorReconnectCopy(locale: 'en' | 'zh'): Record<keyof typeof CONNECTOR_RECONNECT_ZH, string> {
  return locale === 'en' ? CONNECTOR_RECONNECT_EN : CONNECTOR_RECONNECT_ZH;
}
