const deleteIncompleteText = {
  zh: { title: '任务未完成', reason: '删除没有成功，文件还在' },
  en: { title: 'Task incomplete', reason: 'The files are still there because the deletion did not succeed' },
} as const;

export function getDeleteIncompleteText(locale: keyof typeof deleteIncompleteText) {
  return deleteIncompleteText[locale];
}
