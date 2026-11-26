export type ProposeProjectMemoryPreviewLocale = 'zh' | 'en';

/** 与 proposeProjectMemory.schema.ts 的 topic enum 同序；序号即卡片进度 N。 */
export const PROJECT_MEMORY_TOPIC_ORDER = ['purpose', 'key-files', 'conventions'] as const;

type ProposeProjectMemoryPreviewMessages = {
  topicNames: Record<(typeof PROJECT_MEMORY_TOPIC_ORDER)[number], string>;
  summary: (topic: string, n: number, total: number) => string;
  summaryNoTopic: string;
  truncationNote: (shown: number, total: number) => string;
};

const messages: Record<ProposeProjectMemoryPreviewLocale, ProposeProjectMemoryPreviewMessages> = {
  zh: {
    topicNames: { purpose: '项目用途', 'key-files': '重要文件', conventions: '项目约定' },
    summary: (topic, n, total) => `保存一份项目记忆草稿：${topic}（${n}/${total}）`,
    summaryNoTopic: '保存一份项目记忆草稿',
    truncationNote: (shown, total) =>
      `…（草稿较长，这里显示前 ${shown} 字，共 ${total} 字；批准后可在「设置 → 记忆」查看完整内容）`,
  },
  en: {
    topicNames: { purpose: 'what this project is for', 'key-files': 'key files', conventions: 'conventions' },
    summary: (topic, n, total) => `Save a project-memory draft: ${topic} (${n}/${total})`,
    summaryNoTopic: 'Save a project-memory draft',
    truncationNote: (shown, total) =>
      `… (Long draft: showing the first ${shown} of ${total} characters. After approval, the full text is in Settings → Memory.)`,
  },
};

export function getProposeProjectMemoryPreviewMessages(
  locale: ProposeProjectMemoryPreviewLocale,
): ProposeProjectMemoryPreviewMessages {
  return messages[locale];
}
