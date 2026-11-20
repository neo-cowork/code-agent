/**
 * 展示侧绝对路径缩短。两处用户可见文案共用一份匹配与「工作区内相对化」逻辑：
 * - 确认门（approval preview）：工作区外路径原样保留——不得隐藏真实目标；
 * - 代理树/成员视图（agent tree）：工作区外（或根未知）只留最后两段——防 /Users/<name> 泄漏。
 */
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
