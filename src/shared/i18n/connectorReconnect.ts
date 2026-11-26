import type { NativeConnectorDetailCode } from '../ipc/types';

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

interface SpecificConnectorStatusCopy {
  en: string;
  zh: string;
  remedy: 'system-settings' | 'restricted' | 'platform';
}

const SPECIFIC_STATUS_COPY: Partial<Record<NativeConnectorDetailCode, SpecificConnectorStatusCopy>> = {
  automation_not_authorized: {
    en: 'macOS has not allowed Neo to control this app. Allow access in System Settings > Privacy & Security > Automation.',
    zh: 'macOS 尚未允许 Neo 控制此应用。请在系统设置 > 隐私与安全性 > 自动化中允许访问。',
    remedy: 'system-settings',
  },
  calendar_undecided: {
    en: 'Calendar access has not been granted yet. Allow access when macOS asks, or use System Settings > Privacy & Security > Calendars.',
    zh: '尚未授权访问日历。请在 macOS 提示时允许访问，或前往系统设置 > 隐私与安全性 > 日历授权。',
    remedy: 'system-settings',
  },
  calendar_denied: {
    en: 'Calendar access was denied. Allow Full Access in System Settings > Privacy & Security > Calendars.',
    zh: '日历访问权限已被拒绝。请在系统设置 > 隐私与安全性 > 日历中允许完全访问。',
    remedy: 'system-settings',
  },
  calendar_write_only: {
    en: 'Neo can add events to Calendar but cannot read them. Allow Full Access in System Settings > Privacy & Security > Calendars.',
    zh: 'Neo 可以添加日程，但无法读取日程。请在系统设置 > 隐私与安全性 > 日历中允许完全访问。',
    remedy: 'system-settings',
  },
  calendar_restricted: {
    en: 'Calendar access is restricted by the system. You cannot fix this from the Connectors page. Contact your administrator for help.',
    zh: '系统限制了日历访问。连接器页面无法解除此限制，请联系管理员。',
    remedy: 'restricted',
  },
  calendar_desktop_only: {
    en: 'Calendar access is only available in the desktop app.',
    zh: '只能在桌面应用中访问日历。',
    remedy: 'platform',
  },
  platform_unsupported: {
    en: 'This connector only works on a Mac.',
    zh: '此连接器只能在 Mac 上使用。',
    remedy: 'platform',
  },
};

export function getSpecificConnectorStatusCopy(detailCode: NativeConnectorDetailCode | undefined): SpecificConnectorStatusCopy | undefined {
  return detailCode && Object.hasOwn(SPECIFIC_STATUS_COPY, detailCode) ? SPECIFIC_STATUS_COPY[detailCode] : undefined;
}
