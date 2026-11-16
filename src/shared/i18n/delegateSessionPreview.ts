export type DelegateSessionPreviewLocale = 'zh' | 'en';

type DelegateSessionPreviewMessages = {
  target: (title: string) => string;
  fallbackTarget: string;
  delegateExisting: (target: string) => string;
  createNew: string;
  correct: (target: string) => string;
  stop: (target: string) => string;
  resume: (target: string) => string;
  update: (target: string) => string;
  detail: (text: string) => string;
};

const messages: Record<DelegateSessionPreviewLocale, DelegateSessionPreviewMessages> = {
  zh: {
    target: title => `会话「${title}」`,
    fallbackTarget: '另一个会话',
    delegateExisting: target => `把这句话转给${target}`,
    createNew: '新建一个会话来处理这句话',
    correct: target => `更正转给${target}的任务`,
    stop: target => `停止转给${target}的任务`,
    resume: target => `继续转给${target}的任务`,
    update: target => `更新转给${target}的任务`,
    detail: text => `内容：${text}`,
  },
  en: {
    target: title => `the session "${title}"`,
    fallbackTarget: 'another session',
    delegateExisting: target => `Hand this message to ${target}`,
    createNew: 'Start a new session to handle this message',
    correct: target => `Correct the task handed to ${target}`,
    stop: target => `Stop the task handed to ${target}`,
    resume: target => `Resume the task handed to ${target}`,
    update: target => `Update the task handed to ${target}`,
    detail: text => `Content: ${text}`,
  },
};

export function getDelegateSessionPreviewMessages(
  locale: DelegateSessionPreviewLocale,
): DelegateSessionPreviewMessages {
  return messages[locale];
}
