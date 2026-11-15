// ============================================================================
// deleteImpact — 审批请求的删除影响盘点（从 toolExecutor 抽出，控其行数）
// ----------------------------------------------------------------------------
// 宿主给审批请求写 details.affectedPath / details.affectedFileCount。口径与渲染层
// 兜底共用 shared/rmCommandTargets 的同一套解析：解析确切的命令把所有目标的盘点数
// 求和；通配符、变量展开、管道喂入一律不写数字——宁可缺省，也不能把多目标命令
// 标成「约 1 个文件」（N-FIX-APPROVAL-CARD-DELETE-COUNT-UNDERSTATED）。
// ============================================================================

import * as nodeFs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { parseRmTargets } from '../../shared/rmCommandTargets';

/** 盘点上限：超过按数不清处理，与渲染层「多个文件」口径对齐。 */
const COMMAND_FILE_COUNT_LIMIT = 10_000;

/** 命中任一前缀才做删除盘点——其余命令不为审批请求做文件系统扫描。 */
const DELETE_FLAG_PREFIXES = ['recursive_delete', 'root_delete', 'home_delete', 'system_dir_delete', 'container_dir_delete', 'wildcard_delete', 'current_dir_delete', 'sudo_rm'];

async function countAffectedFiles(targetPath: string): Promise<number | undefined> {
  try {
    const root = await nodeFs.lstat(targetPath);
    if (!root.isDirectory()) return 1;
    let count = 0;
    const pending = [targetPath];
    while (pending.length > 0 && count < COMMAND_FILE_COUNT_LIMIT) {
      const directory = pending.pop();
      if (!directory) break;
      const entries = await nodeFs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(nodePath.join(directory, entry.name));
        else count += 1;
        if (count >= COMMAND_FILE_COUNT_LIMIT) break;
      }
    }
    return count;
  } catch {
    return undefined;
  }
}

function resolveTarget(workingDirectory: string, target: string): string {
  return nodePath.isAbsolute(target)
    ? nodePath.resolve(target)
    : nodePath.resolve(workingDirectory, target);
}

export async function computeDeleteImpact(
  command: string,
  securityFlags: string[],
  workingDirectory: string,
): Promise<{ affectedPath: string; affectedFileCount?: number } | undefined> {
  if (!securityFlags.some((flag) => DELETE_FLAG_PREFIXES.some((prefix) => flag.startsWith(prefix)))) return undefined;
  const parsed = parseRmTargets(command);
  const firstTarget = parsed.targets[0];
  if (!firstTarget) return undefined;

  let affectedFileCount: number | undefined;
  if (parsed.exact) {
    let total = 0;
    let complete = true;
    for (const target of parsed.targets) {
      const count = await countAffectedFiles(resolveTarget(workingDirectory, target));
      if (count === undefined) {
        // 任一目标数不出来（不存在/无权限/超上限）就整体缺省，不许拿部分和冒充。
        complete = false;
        break;
      }
      total += count;
    }
    if (complete) affectedFileCount = total;
  }

  return {
    affectedPath: resolveTarget(workingDirectory, firstTarget),
    ...(affectedFileCount !== undefined ? { affectedFileCount } : {}),
  };
}
