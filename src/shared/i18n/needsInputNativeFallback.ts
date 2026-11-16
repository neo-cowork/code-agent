type Locale = 'zh' | 'en';

const messages = {
  zh: {
    single: (action: string) => `等你确认：${action}`,
    multiple: (count: number) => `${count} 项操作等你确认`,
    untitledSession: '未命名任务',
  },
  en: {
    single: (action: string) => `Waiting for your OK: ${action}`,
    multiple: (count: number) => `${count} actions are waiting for your confirmation`,
    untitledSession: 'Untitled task',
  },
};

export function getNeedsInputNativeFallbackText(locale: Locale) {
  return messages[locale];
}
