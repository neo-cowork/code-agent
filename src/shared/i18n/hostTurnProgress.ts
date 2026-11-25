const copy = {
  zh: {
    thinking: '分析请求中...',
    searching: (round: number) => `正在搜索 (第${round}轮)`,
    generating: '生成回复中...',
    report: '正在生成报告...',
    deliveryReview: '交付前自动审查中...',
    incomplete: '回复疑似未完，继续生成剩余内容...',
    truncated: '输出过长，继续生成剩余内容...',
    completed: '回复完成',
  },
  en: {
    thinking: 'Understanding the request',
    searching: (round: number) => `Searching (round ${round})`,
    generating: 'Writing the response',
    report: 'Writing the report',
    deliveryReview: 'Reviewing the result before delivery',
    incomplete: 'Continuing the unfinished response',
    truncated: 'Continuing the long response',
    completed: 'Response complete',
  },
};

export function getHostTurnProgress(locale: keyof typeof copy) {
  return copy[locale];
}
