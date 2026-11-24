import { WAITING_ON_USER_LABELS } from './waitingOnUserLabels';

type Locale = 'zh' | 'en';

const messages = {
  zh: {
    single: (action: string) => WAITING_ON_USER_LABELS.zh.approvalWithLabel.replace('{label}', () => action),
    multiple: (count: number) => `${count} 项操作等你确认`,
    untitledSession: '未命名任务',
  },
  en: {
    single: (action: string) => WAITING_ON_USER_LABELS.en.approvalWithLabel.replace('{label}', () => action),
    multiple: (count: number) => `${count} actions are waiting for your confirmation`,
    untitledSession: 'Untitled task',
  },
};

export function getNeedsInputNativeFallbackText(locale: Locale) {
  return messages[locale];
}
