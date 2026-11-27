/** Human-facing task status; identifiers remain in structured metadata only. */
type Locale = 'zh' | 'en';

const STATUS_LABELS: Record<Locale, Record<string, string>> = {
  zh: {
    queued: '等待开始', running: '进行中', cancelling: '正在停止',
    completed: '已完成', failed: '未完成', cancelled: '已停止',
    'running-recovered': '进行中', unknown: '状态待确认',
  },
  en: {
    queued: 'waiting to start', running: 'in progress', cancelling: 'stopping',
    completed: 'finished', failed: 'not finished', cancelled: 'stopped',
    'running-recovered': 'in progress', unknown: 'status pending',
  },
};

export function sessionTaskStatusLabel(status: string, locale: Locale = 'zh'): string {
  return STATUS_LABELS[locale][status] ?? STATUS_LABELS[locale].unknown;
}

/** delegate_task 受理 / 排队 / 续跟的回执句（父模型会照抄给用户，所以跟界面语言走）。 */
export function formatDelegateTaskReceipt(locale: Locale, input: {
  outcome: 'started' | 'queued' | 'reused';
  shortName: string;
  status: string;
  detail?: string;
  attempt: number;
  retryOf?: { status: string; detail?: string };
}): string {
  const { shortName, status, detail, attempt, retryOf } = input;
  const label = (value: string) => sessionTaskStatusLabel(value, locale);
  if (locale === 'zh') {
    const retry = retryOf
      ? `这是第 ${attempt} 次尝试；上一次${label(retryOf.status)}${retryOf.detail ? `：${retryOf.detail}` : '。'}`
      : '';
    if (input.outcome === 'reused') {
      return `继续跟踪「${shortName}」，当前${label(status)}${detail ? `：${detail}` : '。'}${attempt > 1 ? `这是第 ${attempt} 次尝试。` : ''}`;
    }
    if (input.outcome === 'queued') return `已把「${shortName}」加入排队，空闲后自动开始。${retry}`;
    return `后台任务「${shortName}」已开始，尚未完成；完成后会在这里告诉你结果。${retry}`;
  }
  const retry = retryOf
    ? ` This is attempt ${attempt}; the previous one was ${label(retryOf.status)}${retryOf.detail ? `: ${retryOf.detail}` : '.'}`
    : '';
  if (input.outcome === 'reused') {
    return `Still tracking "${shortName}"; it is currently ${label(status)}${detail ? `: ${detail}` : '.'}${attempt > 1 ? ` This is attempt ${attempt}.` : ''}`;
  }
  if (input.outcome === 'queued') return `"${shortName}" is queued and will start automatically when a slot is free.${retry}`;
  return `Background task "${shortName}" has started and is not finished yet; I will report the result here when it is done.${retry}`;
}
