const COPY = {
  zh: {
    maxIterations: '已达最大执行轮次，任务停止（部分结果已保留）',
    failed: (reason: string) => `任务失败: ${reason}`,
    unknownError: '未知错误',
  },
  en: {
    maxIterations: 'Reached the maximum number of steps, so the task stopped (partial results are kept)',
    failed: (reason: string) => `Task failed: ${reason}`,
    unknownError: 'Unknown error',
  },
} as const;

export function backgroundTaskFailureSummary(
  locale: 'zh' | 'en', kind: 'maxIterations' | 'failed', reason?: string,
): string {
  const copy = COPY[locale];
  return kind === 'maxIterations' ? copy.maxIterations : copy.failed(reason || copy.unknownError);
}
