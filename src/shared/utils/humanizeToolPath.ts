// 把「host 已确认落在真实上传 / 临时根下」的路径显示成「位置词 + 子路径」。
// 是不是上传/临时文件由 host 按真实根判定（host/tools/utils/toolPathKind.ts），这里只做格式化——
// 不凭路径形状猜：没有 host 结论、结论与原值不符、或含 `..` 段的路径一律原样返回。无 os/fs 依赖。

export type ToolPathLocale = 'zh' | 'en';

/** host 对一条路径的分类结论：kind 与根之后的子路径。path 为被分类的原始串，用于核对。 */
export interface ToolPathDisplay {
  path: string;
  kind: 'upload' | 'temp';
  rest: string;
}

const PLACE_WORDS: Record<ToolPathLocale, { temp: string; upload: string }> = {
  zh: { temp: '临时文件：', upload: '你上传的文件：' },
  en: { temp: 'Temporary file: ', upload: 'Your uploaded file: ' },
};

export function humanizeToolPath(raw: string, locale: ToolPathLocale, display?: ToolPathDisplay): string {
  if (display?.path !== raw || !display.rest) return raw;
  if (raw.split(/[\\/]/).includes('..')) return raw;
  return `${PLACE_WORDS[locale][display.kind]}${display.rest}`;
}
