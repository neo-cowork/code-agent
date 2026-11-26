// ============================================================================
// formatPathForDisplay — 用户可见路径的唯一展示入口（可见文字与 title 悬停都走它）
// 规则：工作区内 → `./相对`；家目录下 → `~/…`；其余 → `上级/文件名`。
// 结果永远不含 `/Users/<账户名>`。真实路径只给动作用（「在访达中显示」、复制等），
// 用户想拿到真路径靠这些动作，不靠悬停露出绝对路径。
// ============================================================================

/**
 * 把家目录前缀折成 `~`。认 `/Users/<name>`、`/home/<name>`、`<盘>:\Users\<name>`；
 * 恰好是家目录本身时折成 `~`。Shared / Public / Default 等共享目录不折。渲染端拿不到真实家目录，另一账户的家目录也会被折掉。
 */
export function foldHomePrefixForDisplay(path: string): string {
  const unixHome = /^(?:\/Users|\/home)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (unixHome && isPersonalHomeName(unixHome[1])) return unixHome[2] === undefined ? '~' : `~/${unixHome[2]}`;
  const windowsHome = /^[A-Za-z]:\\Users\\([^\\]+)(?:\\(.*))?$/.exec(path);
  if (windowsHome && isPersonalHomeName(windowsHome[1])) return windowsHome[2] === undefined ? '~' : `~\\${windowsHome[2]}`;
  return path;
}

// 全机共享 / 系统占位目录不是某个人的家目录，折成 ~ 会让用户误以为写的是自己的目录。
const NON_HOME_NAMES = /^(?:shared|guest|public|default|default user|all users|deleted users)$/i;
function isPersonalHomeName(name: string): boolean {
  return name !== '.' && name !== '..' && !NON_HOME_NAMES.test(name);
}

function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  return trimmed || path;
}

/**
 * keepLocation：审批类界面用。工作区外的路径保留完整位置，只折家目录前缀（系统路径没有账户名，
 * 缩成 parent/file 会让用户看不出它在系统目录）；给了 maxLength 且超长时，中段省略、保留前两段与后两段。
 */
function abbreviateMiddle(path: string, maxLength: number): string {
  if (path.length <= maxLength) return path;
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  const parts = path.split(sep);
  if (parts.length <= 4) return path;
  return `${parts.slice(0, 2).join(sep)}${sep}…${sep}${parts.slice(-2).join(sep)}`;
}

export function formatPathForDisplay(
  path: string,
  options: { workspaceRoot?: string | null; keepLocation?: boolean; maxLength?: number } = {},
): string {
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

  // 已是相对路径或 ~ 开头的写法（模型传的 src/utils/format.ts、~/Documents/x）原样显示，不再缩。
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(raw)) return raw;

  const folded = foldHomePrefixForDisplay(raw);
  if (options.keepLocation) return options.maxLength ? abbreviateMiddle(folded, options.maxLength) : folded;
  if (folded !== raw) return folded;

  const segments = raw.split(/[/\\]+/).filter(Boolean);
  // 两段及以内的绝对路径（/tmp/x、/workspace/dist）本身不含账户名，原样保留更清楚
  if (segments.length <= 2) return raw;
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}
