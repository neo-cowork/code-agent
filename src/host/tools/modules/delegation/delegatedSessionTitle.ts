// ============================================================================
// delegatedSessionTitle — delegate_session create_new 的确定性会话标题
// 新会话的侧栏标题（createSession）与回执 targetName 共用这一个短主题；
// 纯文本变换，不读时钟、数据库或 IO。
// 不加 `...` 后缀：isProvisionalAutoTitle 会把「首行前缀 + ...」当自动临时档，
// 让智能标题回头改写；单个 `…`（U+2026）没有这个形状，标题落库后保持稳定。
// ============================================================================

/** 标题上限，按 code points 数（不是 UTF-16 单元），emoji 与增补平面字符安全。 */
const MAX_TITLE_CODE_POINTS = 20;

/** 拿不到正文时的降级标题（沿用旧 createSession 的默认值）。 */
const FALLBACK_TITLE = 'Delegated session';

/** 句读断点：第一个断点符处截断，断点符与其后的内容不进标题（字符类里 `.` 是字面量）。 */
const CLAUSE_BREAK = /[.!?;，。！？；]/;

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

/** 把任务文本压成 ≤20 个 code points 的短主题：首行 → 掐掉行首列表标记与两端引号
 * → 第一个句读断点处截断 → 压缩空白。结果为空时降级 'Delegated session'；
 * 仍超长时截到 19 位补一个 `…`（U+2026，绝不写 `...`）。 */
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
  if (points.length <= MAX_TITLE_CODE_POINTS) return topic;
  return `${points.slice(0, MAX_TITLE_CODE_POINTS - 1).join('')}…`;
}
