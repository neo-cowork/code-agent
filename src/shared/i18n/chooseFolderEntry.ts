/**
 * 侧栏「选择文件夹」入口的唯一文案真源（zh + en）。
 * 侧栏 i18n（节头 + 钮、无项目时的文字行）与 /init-memory 无目录提示词都读这里，
 * 保证模型回复里点名的入口与界面渲染的字面一致。
 */
export const CHOOSE_FOLDER_ENTRY_LABEL: Readonly<Record<'zh' | 'en', string>> = {
  zh: '选择文件夹',
  en: 'Choose folder',
};

export function getInitMemoryNoFolderHint(locale: 'zh' | 'en'): string {
  return locale === 'en'
    ? `No folder has been chosen yet; click "${CHOOSE_FOLDER_ENTRY_LABEL.en}" in the sidebar, then send /init-memory again.`
    : `尚未选择文件夹，请在侧栏点击“${CHOOSE_FOLDER_ENTRY_LABEL.zh}”，然后再次发送 /init-memory。`;
}
