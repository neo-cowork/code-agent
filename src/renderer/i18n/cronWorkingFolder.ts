// ============================================================================
// 定时任务「工作文件夹」文案（N-FIX-CRON-NO-SOURCE-SESSION-NO-WORKDIR）
// 单独成文件：cronCenter.ts 已超行数线，不再往里加。
// ============================================================================

interface CronWorkingFolderCopy {
  label: string;
  notSelected: string;
  hint: string;
  pick: string;
  change: string;
  clear: string;
  pickTitle: string;
  pathPlaceholder: string;
  detailLabel: string;
  detailMissing: string;
  detailMissingHint: string;
}

export const cronWorkingFolderZh: { cronWorkingFolder: CronWorkingFolderCopy } = {
  cronWorkingFolder: {
    label: '工作文件夹',
    notSelected: '未选择',
    hint: '任务运行时会在这个文件夹里读文件；保存文件仍需你另外授权。',
    pick: '选择文件夹',
    change: '更换',
    clear: '清除',
    pickTitle: '选择任务的工作文件夹',
    pathPlaceholder: '输入文件夹的完整路径',
    detailLabel: '工作文件夹',
    detailMissing: '未选择工作文件夹',
    detailMissingHint: '编辑任务，选一个文件夹，运行时才能读到里面的文件。',
  },
};

export const cronWorkingFolderEn: { cronWorkingFolder: CronWorkingFolderCopy } = {
  cronWorkingFolder: {
    label: 'Working folder',
    notSelected: 'Not selected',
    hint: 'The task reads files in this folder when it runs. Saving files still needs your separate permission.',
    pick: 'Choose folder',
    change: 'Change',
    clear: 'Clear',
    pickTitle: 'Choose the task\'s working folder',
    pathPlaceholder: 'Enter the full folder path',
    detailLabel: 'Working folder',
    detailMissing: 'No working folder selected',
    detailMissingHint: 'Edit the task and pick a folder so it can read the files inside.',
  },
};
