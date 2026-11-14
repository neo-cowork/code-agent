// ============================================================================
// Path Utilities - 路径处理工具函数
// ============================================================================

import path from 'path';
import os from 'os';
import { realpathSync } from 'fs';
import { resolveCanonicalRunPath } from '../../runtime/runContext';
import { getUserDataPath } from '../../platform/appPaths';
import { createHostReason, HostReasonCode, type HostReasonPayload } from '../../../shared/contract/permission';
import { CHAT_UPLOAD_DIR_NAME, CHAT_UPLOAD_SUBDIR_NAME } from '../../../shared/constants/chatUploads';

/**
 * 把「可能不存在」的路径规范化：存在的前缀走 realpath（解析 /var → /private/var
 * 这类软链别名），不存在的尾部原样拼回——文件被清理后 realpathSync 会抛，
 * 不能拿它整条解析。
 */
function canonicalizePossiblyMissing(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target; // 到达文件系统根，无法再向上
    return path.join(canonicalizePossiblyMissing(parent), path.basename(target));
  }
}

/**
 * 是否落在聊天上传目录（当前 `<userData>/uploads` 或历史 `os.tmpdir()/code-agent-uploads`）。
 * 读类工具用它在上传副本 ENOENT 时给「上传已过期，请重新上传」的人话提示。
 *
 * macOS os.tmpdir() 返回 /var/…（软链别名），而 document-evidence 锚、上传
 * 回执常以 realpath 形态（/private/var/…）回到读工具——纯词法前缀比对会漏。
 * 词法不中时两侧都按「存在前缀 realpath、缺失尾部保留」规范化再比，
 * 文件与上传根目录都不在了也能对上。
 */
export function isChatUploadPath(filePath: string): boolean {
  const explicitDataDir = process.env.CODE_AGENT_DATA_DIR?.trim();
  const uploadRoots = new Set<string>([
    path.join(getUserDataPath(), CHAT_UPLOAD_SUBDIR_NAME),
    ...(explicitDataDir ? [path.join(path.resolve(explicitDataDir), CHAT_UPLOAD_SUBDIR_NAME)] : []),
    path.join(os.tmpdir(), CHAT_UPLOAD_DIR_NAME),
  ]);
  for (const uploadRoot of uploadRoots) {
    if (filePath.startsWith(`${uploadRoot}${path.sep}`)) return true;
  }
  const canonicalTarget = canonicalizePossiblyMissing(filePath);
  for (const uploadRoot of uploadRoots) {
    const canonicalRoot = canonicalizePossiblyMissing(uploadRoot);
    if (canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) return true;
  }
  return false;
}

export function buildExpiredChatUploadResult(filePath: string): {
  ok: false;
  error: string;
  code: 'ENOENT';
  meta: { hostReason: HostReasonPayload };
} {
  const error = `File not found: ${filePath}（该文件是聊天上传的副本，已失效——请直接告诉用户：附件已失效，请重新拖入）`;
  return {
    ok: false,
    error,
    code: 'ENOENT',
    meta: { hostReason: createHostReason(HostReasonCode.UploadExpired, error) },
  };
}

/**
 * 展开波浪号路径 (~/xxx -> /Users/xxx/xxx)
 * Node.js 原生不支持 ~ 路径展开，需要手动处理
 */
export function expandTilde(filePath: string): string {
  if (!filePath) return filePath;

  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  if (filePath === '~') {
    return os.homedir();
  }

  return filePath;
}

/**
 * 解析路径为绝对路径
 * 1. 展开波浪号
 * 2. 将相对路径转换为绝对路径
 *
 * @param inputPath 输入路径
 * @param workingDirectory 当前工作目录（用于解析相对路径）
 */
export function resolvePath(inputPath: string, workingDirectory: string): string {
  // 先展开波浪号
  let resolvedPath = expandTilde(inputPath);

  // 如果不是绝对路径，则相对于工作目录解析
  if (!path.isAbsolute(resolvedPath)) {
    resolvedPath = path.join(workingDirectory, resolvedPath);
  }

  return confineEvalPath(resolvedPath, workingDirectory);
}

/**
 * Eval 沙箱硬隔离：设了 CODE_AGENT_EVAL_REAL_ROOT 时，把落在"真仓根"下的绝对路径
 * 前缀重映射到沙箱 workingDirectory（结构保留）。其它路径原样返回。
 *
 * Why: eval 全自动批准 permission，agent 的 deny-writes-outside-cwd 防线失效；
 * mimo 可能直接用真仓绝对路径（如 /Users/.../code-agent/x.md）写文件，绕过"改
 * workingDirectory"的沙箱隔离污染主仓。前缀重映射让真仓绝对路径落回沙箱——写不
 * 污染主仓，读真仓路径仍命中沙箱里的 git archive 快照副本。仅 eval 设此 env，
 * 生产不开（生产靠 permission 层的 deny-outside-cwd）。
 */
export function confineEvalPath(resolvedAbsPath: string, workingDirectory: string): string {
  const realRoot = process.env.CODE_AGENT_EVAL_REAL_ROOT;
  if (!realRoot || !workingDirectory) return resolvedAbsPath;
  let root = path.resolve(realRoot);
  let sandbox = path.resolve(workingDirectory);
  let normalized = path.resolve(resolvedAbsPath);
  try {
    root = resolveCanonicalRunPath(root);
    sandbox = resolveCanonicalRunPath(sandbox);
    normalized = resolveCanonicalRunPath(normalized);
  } catch {
    // Fail open to the previous lexical behavior; write tools must remain non-throwing here.
  }
  if (root === sandbox) return resolvedAbsPath; // 没启用沙箱（原地跑）
  if (normalized === root) return sandbox;
  const rel = path.relative(root, normalized);
  // 不在真仓根下（含已在沙箱里的路径）→ 不动
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return resolvedAbsPath;
  return path.join(sandbox, rel);
}
