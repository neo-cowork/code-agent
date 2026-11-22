// ============================================================================
// delegatedSessionTitle — delegate_session create_new 的确定性会话标题
// 新会话的侧栏标题（createSession）与回执 targetName 共用这一个短主题；
// 纯文本变换，不读时钟、数据库或 IO。
// 不加 `...` 后缀：isProvisionalAutoTitle 会把「首行前缀 + ...」当自动临时档，
// 让智能标题回头改写；单个 `…`（U+2026）没有这个形状，标题落库后保持稳定。
// ============================================================================

/** 标题上限，按 code points 数（不是 UTF-16 单元），emoji 与增补平面字符安全。 */
const MAX_TITLE_CODE_POINTS = 20;

/** 末词是文件扩展名时，允许整段保留的上限（仍按 code points）。 */
const MAX_EXTENSION_TITLE_CODE_POINTS = 24;

/** 拿不到正文时的降级标题（沿用旧 createSession 的默认值）。 */
const FALLBACK_TITLE = 'Delegated session';

/** 句读断点：第一个断点符处截断，断点符与其后的内容不进标题。
 * `.` 只在后面是空白或行尾时才算断点，文件名里的点（weekly.md、v1.2）不断。 */
const CLAUSE_BREAK = /(?:\.(?=\s|$)|[!?;，。！？；])/;

/** 最后一个空白分隔的词以文件扩展名结尾（`.md`、`.csv`）。 */
const FILE_EXTENSION_TOKEN = /\.[A-Za-z0-9]{1,5}$/;

/** 两端要去掉的引号（直弯、中西式）。 */
const EDGE_QUOTES = /^["'`“”‘’「」『』《》〈〉]+|["'`“”‘’「」『』《》〈〉]+\s*$/g;

/** 行首列表标记：符号弹点（`- ` 等），或编号（`1. ` / `1)` / `1、`）。 */
const LEADING_SYMBOL_MARKER = /^[-*•·–+]\s+/;
const LEADING_NUMBER_MARKER = /^\d{1,3}(?:[．.]\s+|[、)]\s*)/;

function stripEdges(value: string): string {
  let current = value.trim();
  for (;;) {
    const next = current
      .replace(LEADING_SYMBOL_MARKER, '')
      .replace(LEADING_NUMBER_MARKER, '')
      .replace(EDGE_QUOTES, '')
      .trim();
    if (next === current) return current;
    current = next;
  }
}

function keepsFileExtension(topic: string, pointCount: number): boolean {
  if (pointCount > MAX_EXTENSION_TITLE_CODE_POINTS) return false;
  const lastToken = topic.split(/\s+/).at(-1) ?? '';
  return FILE_EXTENSION_TOKEN.test(lastToken);
}

/** 把任务文本压成短主题：首行 → 掐掉行首列表标记与两端引号
 * → 第一个句读断点处截断 → 压缩空白。结果为空时降级 'Delegated session'。
 * 普通文本超过 20 个 code points 时截到 19 位补一个 `…`（U+2026，绝不写 `...`）。
 * 例外：主题不超过 24 个 code points，且最后一个空白分隔的词以文件扩展名结尾时，整段保留。 */
export function deriveDelegatedSessionTitle(taskText: string | null | undefined): string {
  const firstLine = (taskText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return FALLBACK_TITLE;
  const beforeBreak = stripEdges(firstLine).split(CLAUSE_BREAK, 1)[0];
  const topic = stripEdges(beforeBreak).replace(/\s+/g, ' ').trim();
  if (!topic) return FALLBACK_TITLE;
  const points = [...topic];
  if (points.length <= MAX_TITLE_CODE_POINTS || keepsFileExtension(topic, points.length)) return topic;
  return `${points.slice(0, MAX_TITLE_CODE_POINTS - 1).join('')}…`;
}
