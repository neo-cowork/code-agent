/** Human-facing task status; identifiers remain in structured metadata only. */
export function sessionTaskStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: '等待开始', running: '进行中', cancelling: '正在停止',
    completed: '已完成', failed: '未完成', cancelled: '已停止',
    'running-recovered': '进行中', unknown: '状态待确认',
  };
  return labels[status] ?? '状态待确认';
}
