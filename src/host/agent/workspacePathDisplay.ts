/**
 * 展示侧绝对路径缩短。两处用户可见文案共用一份匹配与「工作区内相对化」逻辑：
 * - 确认门（approval preview）：工作区外路径原样保留——不得隐藏真实目标；
 * - 代理树/成员视图（agent tree）：工作区外（或根未知）只留最后两段——防 /Users/<name> 泄漏。
 */
import { getDatabase } from '../services/core/databaseService';
import { stripWorkdirPrefix } from './workdirPrefix';

const ABSOLUTE_PATH_PATTERN = /(?<![\w:./\\~-])(?:[A-Za-z]:\\|\/)[^\s"'`<>，。；：、）)\]]*/g;

type OutsidePathPolicy = 'keep' | 'tail';

function tailSegments(normalizedPath: string): string {
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments.length > 0 ? segments.slice(-2).join('/') : normalizedPath;
}

function rewriteAbsolutePaths(
  text: string,
  workspaceRoot: string | undefined,
  outside: OutsidePathPolicy,
): string {
  const root = workspaceRoot?.replace(/[\\/]+$/, '');
  const normalizedRoot = root?.replace(/\\/g, '/');
  return text.replace(ABSOLUTE_PATH_PATTERN, (match) => {
    const normalized = match.replace(/\\/g, '/');
    if (normalizedRoot) {
      if (normalized === normalizedRoot) return './';
      if (normalized.startsWith(`${normalizedRoot}/`)) {
        const rest = normalized.slice(normalizedRoot.length + 1);
        return rest ? `./${rest}` : './';
      }
    }
    return outside === 'keep' ? match : tailSegments(normalized);
  });
}

/** 确认门用：工作区内的绝对路径显示为相对路径；工作区外的路径原样保留（不得隐藏真实目标）。 */
export function relativizeWorkspacePaths(text: string, workspaceRoot: string | undefined): string {
  return rewriteAbsolutePaths(text, workspaceRoot, 'keep');
}

/** 代理树展示用：工作区内 → ./相对路径；工作区外（或根未知）→ 只留最后两段，不带家目录前缀。 */
export function shortenDisplayPaths(text: string, workspaceRoot: string | undefined): string {
  return rewriteAbsolutePaths(text, workspaceRoot, 'tail');
}

// 与 renderer RAW_TOOL_DUMP（delegationPresentation.ts）同口径：整段 executor
// 工具结果回放以 `Tool results:` 开头；`Tool X: Success/Error/Failed`、
// `Calling X(` 观测回放行、`[cwd: …]` Bash 工作目录回放行都不是给用户看的卡片文案。
const TOOL_RESULTS_DUMP = /^\s*Tool results:/;
const TOOL_RESULT_LINE = /^Tool \w+: (?:Success|Error|Failed)\b/;
const CALLING_LINE = /^Calling \S+\(/;
const CWD_LINE = /^\[cwd:[^\]]*\]\s*$/;

/**
 * 模型/工具文本 → 展示文本（不截断）：剥注入前缀、丢整段工具回放、剔除回放行与
 * [cwd:] 行、绝对路径按工作区缩短。拿不到自然语言剩余时返回 undefined——
 * 调用方保留上一条好值或中性兜底，绝不把回放怼到用户脸上。
 * outside：卡片短文案用 'tail'；完整全文（成员产出/收到的任务，路径可点击打开）
 * 必须传 'keep'，工作区外路径原样保留，否则会被截成看似相对路径的两段。
 */
export function cleanDisplayText(
  text: string | undefined,
  workspaceRoot: string | undefined,
  outside: OutsidePathPolicy = 'tail',
): string | undefined {
  const stripped = stripWorkdirPrefix(text)?.trim();
  if (!stripped || TOOL_RESULTS_DUMP.test(stripped)) return undefined;
  const remainder = stripped
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !TOOL_RESULT_LINE.test(trimmed) && !CALLING_LINE.test(trimmed) && !CWD_LINE.test(trimmed);
    })
    .join('\n')
    .trim();
  if (!remainder) return undefined;
  return rewriteAbsolutePaths(remainder, workspaceRoot, outside);
}

/**
 * 展示侧工作区根的唯一来源：会话记录里的 workingDirectory（spawn 注入的
 * `[工作目录: …]` 前缀在登记前就被剥掉，存储记录里无处可解析）。DB 未就绪/
 * 会话没落过目录时返回 undefined，所有绝对路径按「区外」缩短处理。
 */
export function resolveSessionWorkspaceRoot(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  try {
    return getDatabase().getSession(sessionId)?.workingDirectory?.trim() || undefined;
  } catch {
    return undefined;
  }
}
