import { PARKED_APPROVAL_ENTRY_PATH } from '../parkedApprovalLocation';

export const APPROVAL_NOTIFICATION_TEXT = {
  zh: {
    title: '需要授权',
    namedTitle: (name: string) => `需要授权：${name}`,
    noTool: '有一项操作等你确认',
    approval: '',
    parked: `。任务已暂停，到${PARKED_APPROVAL_ENTRY_PATH}处理。`,
    first_wake: '。任务已暂停，回到刚创建专家的对话里点「允许」。',
  },
  en: {
    title: 'Approval needed',
    namedTitle: (name: string) => `Approval needed: ${name}`,
    noTool: 'An action is waiting for your approval',
    approval: '',
    parked: '. The task is paused. Open Agent Neo to review the unattended task.',
    first_wake: '. The task is paused. Go back to the chat where you created this expert and tap Allow.',
  },
};
