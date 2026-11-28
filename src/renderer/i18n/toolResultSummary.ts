export const toolResultSummaryZh = {
  toolSummaryCopy: {
    spawnParallel: (count: number) => `创建 ${count} 个代理`,
    spawn: '创建代理',
    messageAgent: '发送消息给代理',
  },
  toolResultSummary: {
    lineCount: { one: '{count} 行', other: '{count} 行' },
    addedLines: { one: '+{count} 行', other: '+{count} 行' },
    removedLines: { one: '-{count} 行', other: '-{count} 行' },
    readLines: { one: '已读取 {count} 行', other: '已读取 {count} 行' },
    readLinesWithSize: { one: '已读取 {count} 行（约 {size}KB）', other: '已读取 {count} 行（约 {size}KB）' },
  },
};

export const toolResultSummaryEn: typeof toolResultSummaryZh = {
  toolSummaryCopy: {
    spawnParallel: (count: number) => `Create ${count} agents`,
    spawn: 'Create agent',
    messageAgent: 'Send message to agent',
  },
  toolResultSummary: {
    lineCount: { one: '{count} line', other: '{count} lines' },
    addedLines: { one: '+{count} line', other: '+{count} lines' },
    removedLines: { one: '-{count} line', other: '-{count} lines' },
    readLines: { one: 'Read {count} line', other: 'Read {count} lines' },
    readLinesWithSize: { one: 'Read {count} line (~{size}KB)', other: 'Read {count} lines (~{size}KB)' },
  },
};
