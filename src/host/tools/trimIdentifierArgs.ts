// 模型输出的标识类参数（路径 / 命令）常带首尾空白或换行（`"\n/tmp/a.txt "`、`"  ls\n"`）。
// 在模型输入边界统一裁一次，授权判定与实际执行才会看到同一个值。
// 正文类字段（content / old_string / new_string …）与嵌套值不动，保持逐字节。

const PATH_LIKE_SUFFIXES = new Set(['file', 'path', 'directory', 'destination', 'target']);

/** 名字像路径、但值不是路径的键：`target` 是 screen/window 枚举，`axPath` 是无障碍树路径。 */
const NON_PATH_KEYS = new Set(['target', 'axPath', 'ax_path']);

export function isPathLikeParameter(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return PATH_LIKE_SUFFIXES.has(normalized.split('_').at(-1) ?? '');
}

export interface TrimIdentifierArgsOptions {
  /** 是否同时裁 `command`。用户手打命令（`!run`）的入口不裁，保持逐字节。 */
  includeCommand: boolean;
}

/** 原地裁顶层路径键（和可选的 command）首尾空白；返回同一个对象。 */
export function trimIdentifierArgs<T>(args: T, options: TrimIdentifierArgsOptions): T {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') continue;
    const isIdentifier = (isPathLikeParameter(key) && !NON_PATH_KEYS.has(key))
      || (options.includeCommand && key === 'command');
    if (!isIdentifier) continue;
    const trimmed = value.trim();
    if (trimmed !== value) record[key] = trimmed;
  }
  return args;
}
