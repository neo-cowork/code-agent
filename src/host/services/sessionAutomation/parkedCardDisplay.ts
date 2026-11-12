/** 收件箱卡片的用户可读形态：去掉系统给定时会话加的前缀，路径参数只露文件名。 */

const SYSTEM_TITLE_PREFIX = /^\[(?:定时|Scheduled?|Cron|Heartbeat)\]\s*/i;

export function stripSystemTitlePrefix(title: string): string {
  return title.trim().replace(SYSTEM_TITLE_PREFIX, '').trim();
}

const ABSOLUTE_PATH = /^(?:\/|~[/\\]|[A-Za-z]:[\\/])/;
const SHELL_SYNTAX = /[\n|&;<>$`]|\s-{1,2}\w/;

/** 整串就是一个绝对路径时只保留文件名；命令行等其它预览原样返回。 */
export function toUserFacingArgsPreview(preview: string | undefined): string | undefined {
  if (!preview) return preview;
  const trimmed = preview.trim();
  if (!ABSOLUTE_PATH.test(trimmed) || SHELL_SYNTAX.test(trimmed)) return preview;
  const base = trimmed.split(/[\\/]/).filter(Boolean).pop();
  return base || preview;
}
