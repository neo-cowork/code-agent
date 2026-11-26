export const toolResultSummaryZh = {
  toolSummaryCopy: {
    spawnParallel: (count: number) => `创建 ${count} 个代理`,
    spawn: '创建代理',
    messageAgent: '发送消息给代理',
  },
  toolResultSummary: {
    lineCount: '{count} 行',
    addedLines: '+{count} 行',
    removedLines: '-{count} 行',
    readLines: '已读取 {count} 行',
    readLinesWithSize: '已读取 {count} 行（约 {size}KB）',
  },
};

export const toolResultSummaryEn: typeof toolResultSummaryZh = {
  toolSummaryCopy: {
    spawnParallel: (count: number) => `Create ${count} agents`,
    spawn: 'Create agent',
    messageAgent: 'Send message to agent',
  },
  toolResultSummary: {
    lineCount: '{count} lines',
    addedLines: '+{count} lines',
    removedLines: '-{count} lines',
    readLines: 'Read {count} lines',
    readLinesWithSize: 'Read {count} lines (~{size}KB)',
  },
};
