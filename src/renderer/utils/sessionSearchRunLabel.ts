/**
 * 搜索结果里同标题同分钟的会话（如定时任务连续两次运行）需要看到秒才能分辨。
 * 在已格式化的时间标签里，把第一个 H:mm 扩成 H:mm:ss；找不到时间片段则在末尾补 :SS。
 * 去掉秒片段后与原标签完全一致。
 */
export function withSecondsLabel(label: string, timestamp: number): string {
  const seconds = String(new Date(timestamp).getSeconds()).padStart(2, '0');
  const matched = /\d{1,2}:\d{2}/.exec(label);
  if (!matched) return `${label}:${seconds}`;
  const end = matched.index + matched[0].length;
  return `${label.slice(0, end)}:${seconds}${label.slice(end)}`;
}

interface RunLabelRow {
  title: string;
  label: string;
  updatedAt: number;
  createdAt: number;
}

/** 返回每行的时间标签，以及每个碰撞组里最新那一行的下标集合。 */
export function resolveSearchRunLabels(rows: RunLabelRow[]): { labels: string[]; latest: Set<number> } {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const key = `${row.title}\u0000${row.label}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const labels = rows.map((row) => row.label);
  const latest = new Set<number>();
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    indexes.forEach((i) => {
      labels[i] = withSecondsLabel(rows[i].label, rows[i].updatedAt);
    });
    // 最新：updatedAt 大者优先，平局取 createdAt 大者，再平局取列表靠前者
    const best = indexes.reduce((a, b) => {
      if (rows[b].updatedAt !== rows[a].updatedAt) return rows[b].updatedAt > rows[a].updatedAt ? b : a;
      if (rows[b].createdAt !== rows[a].createdAt) return rows[b].createdAt > rows[a].createdAt ? b : a;
      return a;
    });
    latest.add(best);
  }
  return { labels, latest };
}
