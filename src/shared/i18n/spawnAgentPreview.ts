type SpawnAgentPreviewMessages = {
  unspecifiedTask: string;
  parallelSummary: (count: number) => string;
  taskLine: (task: string) => string;
  permissionLine: (permission: string) => string;
  readOnlyPermission: string;
  writePermission: string;
};

const messages: Record<'zh' | 'en', SpawnAgentPreviewMessages> = {
  zh: {
    unspecifiedTask: '未说明任务',
    parallelSummary: count => `派出 ${count} 个子代理`,
    taskLine: task => `任务：${task}`,
    permissionLine: permission => `权限：${permission}`,
    readOnlyPermission: '只读查看',
    writePermission: '可修改文件、运行命令',
  },
  en: {
    unspecifiedTask: 'Task not stated',
    parallelSummary: count => `Spawn ${count} sub-agents`,
    taskLine: task => `Task: ${task}`,
    permissionLine: permission => `Permission: ${permission}`,
    readOnlyPermission: 'Read-only',
    writePermission: 'Can modify files and run commands',
  },
};

export function getSpawnAgentPreviewMessages(locale: 'zh' | 'en'): SpawnAgentPreviewMessages {
  return messages[locale];
}
