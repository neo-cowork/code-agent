// ============================================================================
// plainEvidenceText — 角色醒来 <evidence> 的人话化（host 与 renderer 共用同一规则）
// ============================================================================
// 模型常在证据里写 `workspace/weekly/2026-W46.md` 这类内部相对路径，原样会落到
// 消息 metadata / 履历行 / 自动化记录。本函数把证据压成可读引文：
//   markdown 链接 [x](y) -> x；去反引号与 ** / __；
//   任何含 / 或 \ 的路径段（绝对或相对）-> 最后一段并去扩展名；
//   裸文件名（history.md / 周报.md）-> 去扩展名；
//   收敛空白。纯中文陈述原样返回。
// 判路径的保守口径：纯数字分段（12/18、2026/11/20 这类日期/比值）与两侧都不是
// 路径字符的孤立「/」（他/她、和/或）不算路径，原样保留。

const MD_LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g;
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s，。；：、"'`\]()（）【】《》]+/g;
const WIN_ABS_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][A-Za-z0-9_@.~+:\\/-]*/g;
// 两侧至少一侧是 ASCII 路径字符才算路径段（保住「他/她」这类孤立斜杠）
const SLASH_PATH_RE = /[A-Za-z0-9_@.~+-]+[\\/][A-Za-z0-9_@.~+:\\/-]*|[A-Za-z0-9_@.~+:\\/-]*[\\/][A-Za-z0-9_@.~+-]+/g;
// 含 CJK 段的路径只在末段带文档扩展名时才视为路径（避免误伤「和/或」这类并列）
const CJK_DOC_PATH_RE = /[\p{L}\p{N}_.@~+-]+[\\/][\p{L}\p{N}_.@~+:\\/-]*\.(?:md|markdown|txt|log|pdf|docx?|xlsx?|xls|pptx?|ppt|csv|json|jsonl|ya?ml|toml|xml|html?|png|jpe?g|gif|svg|webp|mp3|mp4|mov|zip|tar|gz|tgz|sql|db|ts|tsx|jsx?|py|rs|go|java|sh|css)\b/giu;
// 清完路径后仍残留的 CJK 目录前缀（如 工作区/weekly/x -> x 后的兜底）
const CJK_DIR_PREFIX_RE = /[\p{L}\p{N}_.@~-]+[\\/]+(?=[A-Za-z0-9_@.~-])/gu;
const BARE_DOC_RE = /[\p{L}\p{N}_@-]+(?:\.(?:md|markdown|txt|log|pdf|docx?|xlsx?|xls|pptx?|ppt|csv|json|jsonl|ya?ml|toml|xml|html?|png|jpe?g|gif|svg|webp|mp3|mp4|mov|zip|tar|gz|tgz|sql|db|ts|tsx|jsx?|py|rs|go|java|sh|css)\b)+/giu;
const FILE_EXT_TAIL_RE = /\.[A-Za-z0-9]{1,8}$/;
const TRAILING_DOC_EXTS_RE = /(?:\.[\p{L}\p{N}]{1,8})+$/u;

function basenameNoExt(token: string): string {
  const segments = token.split(/[\\/]+/).filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  return last.replace(FILE_EXT_TAIL_RE, '');
}

function isNumericOnlyPath(token: string): boolean {
  const segments = token.split(/[\\/]+/).filter(Boolean);
  return segments.length > 0 && segments.every((segment) => /^\d+$/.test(segment));
}

/**
 * 把一条 evidence 压成可读引文：不带 /-路径、.md 或反引号。
 * 输入为空或全空白时返回 ''。
 */
export function plainEvidenceText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const withoutMarkup = trimmed
    .replace(MD_LINK_RE, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/`+/g, '');
  return withoutMarkup
    .replace(URL_RE, basenameNoExt)
    .replace(CJK_DOC_PATH_RE, basenameNoExt)
    .replace(WIN_ABS_RE, basenameNoExt)
    .replace(SLASH_PATH_RE, (match) => (isNumericOnlyPath(match) ? match : basenameNoExt(match)))
    .replace(CJK_DIR_PREFIX_RE, '')
    .replace(BARE_DOC_RE, (match) => match.replace(TRAILING_DOC_EXTS_RE, ''))
    .replace(/\s+/g, ' ')
    .trim();
}
