// 附件显示名：旧草稿/旧消息里 name 可能是绝对路径，只显示最后一段；
// 文件夹上传的 `dir/file.txt` 不是绝对路径形态，原样保留。

const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/;

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function getAttachmentDisplayName(name: string): string {
  return ABSOLUTE_PATH_RE.test(name) ? lastSegment(name) : name;
}

interface HoverPathInput {
  id: string;
  name: string;
  path?: string;
}

/**
 * 同一输入框里文件名相同的 chip 才给悬停路径：工作区内给相对路径，
 * 工作区外给「上级文件夹/文件名」，永不返回绝对路径。
 */
export function getCollisionHoverTitles(
  attachments: HoverPathInput[],
  workingDirectory: string | null,
): Map<string, string> {
  const byName = new Map<string, HoverPathInput[]>();
  for (const attachment of attachments) {
    const name = getAttachmentDisplayName(attachment.name);
    byName.set(name, [...(byName.get(name) ?? []), attachment]);
  }
  const titles = new Map<string, string>();
  const root = workingDirectory ? `${workingDirectory.replace(/\/+$/, '')}/` : null;
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    for (const attachment of group) {
      const path = attachment.path ?? attachment.name;
      if (root && path.startsWith(root)) {
        titles.set(attachment.id, path.slice(root.length));
        continue;
      }
      const parts = path.split(/[\\/]/).filter(Boolean);
      titles.set(attachment.id, parts.length >= 2 ? `${parts[parts.length - 2]}/${name}` : name);
    }
  }
  return titles;
}
