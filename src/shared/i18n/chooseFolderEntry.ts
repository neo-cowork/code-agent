/**
 * 侧栏「选择文件夹」入口的唯一文案真源（zh + en）。
 * 侧栏 i18n（节头 + 钮、无项目时的文字行）与 /init-memory 无目录提示词都读这里，
 * 保证模型回复里点名的入口与界面渲染的字面一致。
 */
export const CHOOSE_FOLDER_ENTRY_LABEL: Readonly<Record<'zh' | 'en', string>> = {
  zh: '选择文件夹',
  en: 'Choose folder',
};
