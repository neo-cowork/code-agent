// ============================================================================
// formatPathForDisplay — 用户可见路径的唯一展示入口（可见文字与 title 悬停都走它）
// 规则：工作区内 → `./相对`；家目录下 → `~/…`；其余 → `上级/文件名`。
// 结果永远不含 `/Users/<账户名>`。真实路径只给动作用（「在访达中显示」、复制等），
// 用户想拿到真路径靠这些动作，不靠悬停露出绝对路径。
// ============================================================================

/**
 * 把家目录前缀折成 `~`。认 `/Users/<name>`、`/home/<name>`、`<盘>:\Users\<name>`；
 * 恰好是家目录本身时折成 `~`。渲染端拿不到真实家目录，另一账户的家目录也会被折掉。
 */
export function foldHomePrefixForDisplay(path: string): string {
  const unixHome = /^(?:\/Users|\/home)\/[^/]+\/(.*)$/.exec(path);
  if (unixHome) return `~/${unixHome[1]}`;
  if (/^(?:\/Users|\/home)\/[^/]+$/.test(path)) return '~';
  const windowsHome = /^[A-Za-z]:\\Users\\[^\\]+\\(.*)$/.exec(path);
  if (windowsHome) return `~\\${windowsHome[1]}`;
  if (/^[A-Za-z]:\\Users\\[^\\]+$/.test(path)) return '~';
  return path;
}

function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  return trimmed || path;
}

export function formatPathForDisplay(path: string, options: { workspaceRoot?: string | null } = {}): string {
  const raw = (path ?? '').trim();
  if (!raw) return '';

  // 含 `..` 的路径不缩短：审批卡上缩成「上级/文件名」会把穿越藏起来，只折家目录前缀。
  if (raw.split(/[/\\]+/).includes('..')) return foldHomePrefixForDisplay(raw);

  const root = options.workspaceRoot ? trimTrailingSeparators(options.workspaceRoot.trim()) : '';
  if (root && root !== '/' && root !== '\\') {
    if (raw === root || raw === `${root}/` || raw === `${root}\\`) return './';
    for (const sep of ['/', '\\']) {
      if (raw.startsWith(root + sep)) {
        const rest = raw.slice(root.length + 1).replace(/[/\\]+$/, '');
        return rest ? `./${rest}` : './';
      }
    }
  }

  const folded = foldHomePrefixForDisplay(raw);
  if (folded !== raw) return folded;

  const segments = raw.split(/[/\\]+/).filter(Boolean);
  // 两段及以内的绝对路径（/tmp/x、/workspace/dist）本身不含账户名，原样保留更清楚
  if (segments.length <= 2) return raw;
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}
