// ============================================================================
// plainEvidenceText — 角色醒来 <evidence> 的人话化（host 与 renderer 共用同一规则）
// ============================================================================
// 模型常在证据里写 `workspace/weekly/2026-W46.md` 这类内部相对路径，原样会落到
// 消息 metadata / 履历行 / 自动化记录。本函数把证据压成可读引文：
//   markdown 链接 [x](y) -> x；去反引号与 ** / __；
//   明确像文件路径的 token -> 最后一段并去扩展名；
//   裸文件名（history.md / 周报.md）-> 去扩展名；
//   收敛空白。纯中文陈述与单斜杠缩写（CI/CD、A/B、4.5/5、他/她）原样返回。
// 判路径的保守口径：对「由分隔符连成的整个 token」一次判定（isPathLike），不再
// 分段拼接——r2 复判的教训：分段处理会让兜底规则吞掉「中文+CI/」整段，把
// 『周会CI/CD流水线』改坏成『CD流水线』且不可恢复；基线是原样保留。

const MD_LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g;
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s，。；：、"'`\]()（）【】《》]+/g;
const WIN_ABS_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][A-Za-z0-9_@.~+:\\/-]*/g;
// 由 / \ 连成的完整 token（可带前导分隔符、可含 CJK 段）：workspace/weekly/x、
// 工作区/weekly/2026-W46.md、周会CI/CD流水线、2026/11/20。
const SLASH_TOKEN_RE = /[\p{L}\p{N}_.@~+-]*(?:[\\/]+[\p{L}\p{N}_.@~+-]+)+/gu;
const BARE_DOC_RE = /[\p{L}\p{N}_@-]+(?:\.(?:md|markdown|txt|log|pdf|docx?|xlsx?|xls|pptx?|ppt|csv|json|jsonl|ya?ml|toml|xml|html?|png|jpe?g|gif|svg|webp|mp3|mp4|mov|zip|tar|gz|tgz|sql|db|ts|tsx|jsx?|py|rs|go|java|sh|css)\b)+/giu;
const TRAILING_DOC_EXTS_RE = /(?:\.[\p{L}\p{N}]{1,8})+$/u;

function basenameNoExt(token: string): string {
  const segments = token.split(/[\\/]+/).filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  return last.replace(/\.[A-Za-z0-9]{1,8}$/, '');
}

const DOC_EXT_TAIL_RE = /\.(?:md|markdown|txt|log|pdf|docx?|xlsx?|xls|pptx?|ppt|csv|json|jsonl|ya?ml|toml|xml|html?|png|jpe?g|gif|svg|webp|mp3|mp4|mov|zip|tar|gz|tgz|sql|db|ts|tsx|jsx?|py|rs|go|java|sh|css)$/i;

// 只在明确像文件路径时才化简：以 / \ ~ . 开头、盘符开头、末段带文档扩展名、
// 或 ≥3 段且中间段都像目录名（含 ASCII 字母——2026/11/20、在2026/11/20核对过
// 这类日期的中间段是纯数字，不算路径）。
// CI/CD、A/B、4.5/5、他/她、周会CI/CD流水线 这类单斜杠缩写/比值原样保留。
function isPathLike(token: string): boolean {
  if (/^[\\/~.]/.test(token)) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  if (DOC_EXT_TAIL_RE.test(token)) return true;
  const segments = token.split(/[\\/]+/).filter(Boolean);
  return segments.length >= 3 && segments.slice(1, -1).every((s) => /[A-Za-z]/.test(s));
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
    .replace(WIN_ABS_RE, basenameNoExt)
    .replace(SLASH_TOKEN_RE, (match) => (isPathLike(match) ? basenameNoExt(match) : match))
    .replace(BARE_DOC_RE, (match) => match.replace(TRAILING_DOC_EXTS_RE, ''))
    .replace(/\s+/g, ' ')
    .trim();
}
