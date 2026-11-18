// 把工具参数里的临时 / 上传目录绝对路径显示成「位置词 + 子路径」。
// 只认精确的根目录；含 `..` 段的路径一律原样返回（不替用户折叠可能的穿越）。无 os/fs 依赖，host 与 renderer 共用。

export type ToolPathLocale = 'zh' | 'en';

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOAD_ROOT_NAMES = new Set(['uploads', 'code-agent-uploads']);

const PLACE_WORDS: Record<ToolPathLocale, { temp: string; upload: string }> = {
  zh: { temp: '临时文件：', upload: '你上传的文件：' },
  en: { temp: 'Temporary file: ', upload: 'Your uploaded file: ' },
};

/** 返回临时目录根之后的段下标；不是临时目录返回 -1。 */
function tempRootEnd(segs: string[]): number {
  let i = 1;
  if (segs[i] === 'private') i += 1;
  if (segs[i] === 'tmp') return i + 1;
  if (segs[i] === 'var' && segs[i + 1] === 'folders' && segs[i + 2] && segs[i + 3] && segs[i + 4] === 'T') {
    return i + 5;
  }
  return -1;
}

export function humanizeToolPath(raw: string, locale: ToolPathLocale): string {
  if (!raw.startsWith('/')) return raw;
  const segs = raw.split('/');
  if (segs.some(seg => seg === '..')) return raw;
  const words = PLACE_WORDS[locale];

  const uploadIdx = segs.findIndex((seg, i) => i > 0 && UPLOAD_ROOT_NAMES.has(seg) && UUID_SEGMENT.test(segs[i + 1] ?? ''));
  if (uploadIdx >= 0) {
    const rest = segs.slice(uploadIdx + 2).filter(Boolean).join('/');
    return rest ? `${words.upload}${rest}` : raw;
  }

  const end = tempRootEnd(segs);
  if (end > 0) {
    const rest = segs.slice(end).filter(Boolean).join('/');
    return rest ? `${words.temp}${rest}` : raw;
  }
  return raw;
}
