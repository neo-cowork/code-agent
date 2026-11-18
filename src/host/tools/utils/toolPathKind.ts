// host 侧按真实根判定一条工具路径是「聊天上传」还是「系统临时目录」。
// 只认 getChatUploadRoots()（<userData>/uploads、CODE_AGENT_DATA_DIR/uploads、os.tmpdir()/code-agent-uploads）
// 与 os.tmpdir()（及非 Windows 的 /tmp），两侧都做 realpath 规范化（/var 与 /private/var 别名）。含 `..` 段一律不分类。
import os from 'os';
import path from 'path';
import { canonicalizePossiblyMissing, getChatUploadRoots } from '../file/pathUtils';
import type { ToolPathDisplay } from '../../../shared/utils/humanizeToolPath';

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function relativeUnder(root: string, target: string): string[] | undefined {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).filter(Boolean);
}

function underAny(roots: string[], target: string, canonicalTarget: string): string[] | undefined {
  for (const root of roots) {
    const hit = relativeUnder(root, target) ?? relativeUnder(canonicalizePossiblyMissing(root), canonicalTarget);
    if (hit) return hit;
  }
  return undefined;
}

export function classifyToolPath(raw: string): ToolPathDisplay | undefined {
  if (!path.isAbsolute(raw) || raw.split(/[\\/]/).some(seg => seg === '..')) return undefined;
  const target = path.resolve(raw);
  const canonicalTarget = canonicalizePossiblyMissing(target);

  const uploadHit = underAny(getChatUploadRoots(), target, canonicalTarget);
  if (uploadHit && UUID_SEGMENT.test(uploadHit[0] ?? '') && uploadHit.length > 1) {
    return { path: raw, kind: 'upload', rest: uploadHit.slice(1).join('/') };
  }

  const tempRoots = [os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])];
  const tempHit = underAny(tempRoots, target, canonicalTarget);
  if (tempHit) return { path: raw, kind: 'temp', rest: tempHit.join('/') };
  return undefined;
}
