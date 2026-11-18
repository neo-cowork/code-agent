// 通用工具审批卡的参数名本地化：内部参数名（output_path / sheet_name / dry_run…）不直接上卡。

export type ToolParamLocale = 'zh' | 'en';

const LABELS: Record<string, { zh: string; en: string }> = {
  output_path: { zh: '保存到', en: 'Save to' },
  file_path: { zh: '文件', en: 'File' },
  path: { zh: '路径', en: 'Path' },
  sheet_name: { zh: '工作表', en: 'Sheet' },
  title: { zh: '标题', en: 'Title' },
  theme: { zh: '主题', en: 'Theme' },
  url: { zh: '网址', en: 'Link' },
  query: { zh: '搜索内容', en: 'Search for' },
  subject: { zh: '主题', en: 'Subject' },
  description: { zh: '说明', en: 'Description' },
  action: { zh: '操作', en: 'Action' },
};

const GENERIC_LABEL = { zh: '详情', en: 'Details' };

export function getToolParamLabel(key: string, locale: ToolParamLocale): string {
  return (LABELS[key] ?? GENERIC_LABEL)[locale];
}

/** 指向文件位置的参数：排在最前，保证保存位置不被 3 行上限挤掉。 */
export function isPathLikeParamKey(key: string): boolean {
  return /(^|_)(path|file|dir|directory|folder)$/.test(key);
}

/** 内部开关 / 不透明标识：不展示。 */
export function isHiddenParamEntry(key: string, value: string): boolean {
  return /^(true|false)$/i.test(value) || /(^|_)id$/i.test(key);
}
