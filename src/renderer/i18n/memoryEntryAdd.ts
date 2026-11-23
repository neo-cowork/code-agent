// 设置 > 记忆 > 「添加记忆」入口文案（zh + en）。独立文件：knowledge/settings 文案文件已近行数上限。
export interface MemoryEntryAddCopy {
  button: string;
  title: string;
  placeholder: string;
  typeLabel: string;
  kinds: { user: string; feedback: string; project: string; reference: string };
  save: string;
  saving: string;
  cancel: string;
  emptyContent: string;
  duplicate: string;
  failed: string;
  saved: string;
  addedManually: string;
}

export const MEMORY_ENTRY_ADD_COPY: Record<'zh' | 'en', MemoryEntryAddCopy> = {
  zh: {
    button: '添加记忆',
    title: '想让 Neo 记住什么？',
    placeholder: '例如：我喜欢用中文回复',
    typeLabel: '记忆类型',
    kinds: { user: '关于我', feedback: '我喜欢的做事方式', project: '项目', reference: '参考资料' },
    save: '保存',
    saving: '正在保存…',
    cancel: '取消',
    emptyContent: '请先写下想让 Neo 记住的内容。',
    duplicate: '这条记忆已经存在，已为你选中它。',
    failed: '保存失败，请稍后再试。',
    saved: '已添加这条记忆。',
    addedManually: '手动添加',
  },
  en: {
    button: 'Add memory',
    title: 'What should Neo remember?',
    placeholder: 'For example: I prefer replies in Chinese',
    typeLabel: 'Memory type',
    kinds: { user: 'About me', feedback: 'How I like things done', project: 'Project', reference: 'Reference' },
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    emptyContent: 'Write what you want Neo to remember first.',
    duplicate: 'This memory already exists. It has been selected for you.',
    failed: 'Could not save. Please try again.',
    saved: 'Memory added.',
    addedManually: 'Added manually',
  },
};
