// ============================================================================
// Cron Write Grant — 定时任务「预授权写入文件夹」host 侧（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1）
// ============================================================================
// 用户在任务详情面板一键授权（专用 IPC，updateJob/createJob 都写不进这个字段），
// 授权文件夹 = 运行会话的工作目录同源判定（shared/cronWriteScope.cronWriteScopeFolder，
// 常设刷新取产物所在目录，其余取来源会话工作目录）。运行时无人值守（壳已退出，
// ADR-083 background）的 cron/heartbeat 会话写这个文件夹内的 file_write/file_edit
// 自动放行；出界、非边界成因的 forceConfirm、保护路径/禁写名、Bash、其余工具一律
// 照旧停车等人。
//
// 授权语义对照 loginPassThroughOrigin 先例：显式同意才落库、普通编辑不可夹带、
// 会话 origin.metadata 随 run 带走、消费侧只认 host 侧解析结果。
// ============================================================================

import * as fs from 'fs';
import os from 'os';
import path from 'path';
import type { PermissionAskResult } from '../../shared/contract';
import { PermissionRequestReason } from '../../shared/contract/permission';
import type { CronJobDefinition } from '../../shared/contract/cron';
import {
  CRON_WRITE_GRANT_METADATA_KEY,
  CRON_WRITE_SCOPE_NO_FOLDER,
  cronSourceSessionIdFromDefinition,
  cronWriteScopeFolder,
  writeGrantRootFromMetadata,
} from '../../shared/cronWriteScope';
import {
  getSensitiveSandboxPaths,
  isForbiddenWriteNameUnderRoot,
  isProtectedWritePath,
} from '../sandbox/sensitivePaths';
import { getUserConfigDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';
import { expandTilde, resolveInputPath } from '../tools/utils/resolveInputPath';

const logger = createLogger('CronWriteGrant');

/** CronService 暴露给本模块的最小宿主面（同 rememberCronLoginPassThroughOrigin 的注入形态）。 */
export interface CronWriteGrantHost {
  /** 内存 job 表取活跃条目（definition 可变引用，授权写回后内存立即生效）。 */
  loadActiveJob: (jobId: string) => { definition: CronJobDefinition } | undefined;
  /** 即 CronService.persistJob：落库。 */
  persistJob: (definition: CronJobDefinition) => Promise<void>;
}

function realpathOrNull(value: string): string | undefined {
  try {
    return fs.realpathSync(value);
  } catch {
    return undefined;
  }
}

/**
 * 目标文件可能还不存在（新写入）：沿目录链向上找第一个存在的祖先做 realpath，
 * 再把缺失尾段接回去。全链都不存在（连根都解析不出）返回 undefined。
 */
function realpathWithMissingTail(resolved: string): string | undefined {
  let current = resolved;
  const tail: string[] = [];
  for (;;) {
    const real = realpathOrNull(current);
    if (real) return tail.length === 0 ? real : path.join(real, ...[...tail].reverse());
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    tail.push(path.basename(current));
    current = parent;
  }
}

/**
 * 判定目标是否落在授权文件夹内。两边都做 realpath 归一：
 * `..` 由 path.resolve 归一，symlink 逃逸由 realpath 归一（授权目录内的软链指向
 * 外部 → 解析后落在界外 → 不放行）。只收绝对路径（相对目标由调用方先对会话
 * workingDirectory 归一）；授权根不存在一律 fail-closed 拒。
 * 模块私有：外部统一走 approveByScheduleWriteGrant（生产消费方只有它）。
 */
function isPathWithinWriteGrantRoot(target: string, grantRoot: string): boolean {
  if (!path.isAbsolute(target)) return false;
  const realRoot = realpathOrNull(grantRoot);
  if (!realRoot) return false;
  const realTarget = realpathWithMissingTail(path.resolve(target));
  if (!realTarget) return false;
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/** 来源会话的工作目录（授权解析只用来源会话，不取「当前焦点会话」兜底——授权范围必须稳定可预期）。 */
async function sourceSessionWorkingDirectory(definition: CronJobDefinition): Promise<string | undefined> {
  const sourceSessionId = cronSourceSessionIdFromDefinition(definition);
  if (!sourceSessionId) return undefined;
  try {
    const { getSessionManager } = await import('../services/infra/sessionManager');
    const session = await getSessionManager().getSession(sourceSessionId).catch(() => null);
    return session?.workingDirectory;
  } catch (error) {
    logger.warn('Failed to read the cron source session, resolving without its working directory', { error });
    return undefined;
  }
}

/**
 * 授权：解析候选文件夹并写入 metadata.writeGrantRoot。解析不出文件夹抛
 * CRON_WRITE_SCOPE_NO_FOLDER（面板据此切「先在对话里选工作文件夹」提示态）。
 * 已授权时幂等返回当前定义，不重复解析。
 */
export async function grantCronWriteScope(
  jobId: string,
  host: CronWriteGrantHost,
  updatedAt?: number,
): Promise<CronJobDefinition | null> {
  const active = host.loadActiveJob(jobId);
  if (!active) return null;
  if (writeGrantRootFromMetadata(active.definition.metadata)) return active.definition;
  const folder = cronWriteScopeFolder(active.definition, await sourceSessionWorkingDirectory(active.definition));
  const resolved = folder && path.isAbsolute(folder) ? folder : undefined;
  if (!resolved) throw new Error(CRON_WRITE_SCOPE_NO_FOLDER);
  const updated: CronJobDefinition = {
    ...active.definition,
    metadata: { ...(active.definition.metadata ?? {}), [CRON_WRITE_GRANT_METADATA_KEY]: resolved },
    updatedAt: updatedAt ?? Date.now(),
  };
  await host.persistJob(updated);
  active.definition = updated;
  logger.info('Write scope granted', { jobId, root: resolved });
  return updated;
}

/** 撤销：摘掉 metadata.writeGrantRoot。未授权时幂等返回当前定义。 */
export async function revokeCronWriteScope(
  jobId: string,
  host: CronWriteGrantHost,
  updatedAt?: number,
): Promise<CronJobDefinition | null> {
  const active = host.loadActiveJob(jobId);
  if (!active) return null;
  if (!writeGrantRootFromMetadata(active.definition.metadata)) return active.definition;
  const metadata = { ...(active.definition.metadata ?? {}) };
  delete metadata[CRON_WRITE_GRANT_METADATA_KEY];
  const updated: CronJobDefinition = {
    ...active.definition,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    updatedAt: updatedAt ?? Date.now(),
  };
  await host.persistJob(updated);
  active.definition = updated;
  logger.info('Write scope revoked', { jobId });
  return updated;
}

/** createJob 元数据防线：外部载荷不许夹带授权字段（no-self-grant，updateJob 同理走 sanitize）。 */
export function stripWriteGrantRoot(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, CRON_WRITE_GRANT_METADATA_KEY)) return metadata;
  const rest = { ...metadata };
  delete rest[CRON_WRITE_GRANT_METADATA_KEY];
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * 无人值守审批的写授权放行判定（orchestratorPermissions 在停车分支之前调用）。
 * 返回 undefined = 不适用（非 cron/heartbeat 来源、非 file_write/file_edit、
 * forceConfirm、无授权、目标出界），调用方照旧走停车/询问。
 * 相对路径目标（真模型第一发 Write 的自然形状，2026-10-24 GLM 真跑实证：`today-note.txt`）
 * 对会话工作目录归一后判界——cron 会话 cwd 就是授权根，语义上「写进自己文件夹」；
 * 会话没有工作目录时维持 fail-closed 拒（不猜落点）。
 */
export async function approveByScheduleWriteGrant(request: {
  sessionId?: string;
  type: string;
  tool?: string;
  forceConfirm?: boolean;
  /** toolExecutor 的成因标记：true 仅当 W3 写边界 ask 是 forceConfirm 的唯一成因。 */
  forceConfirmBoundaryOnly?: boolean;
  reasonCode?: PermissionRequestReason;
  /** 宽收窄用：只消费 path/file_path；其余键（command/url 等）在场即说明不是文件写目标。 */
  details?: { path?: string; filePath?: string; [key: string]: unknown };
}): Promise<PermissionAskResult | undefined> {
  if (request.type !== 'file_write' && request.type !== 'file_edit') return undefined;
  // forceConfirm 只放行「W3 写边界 ask 为唯一成因」这一种形态（返修 r2）：cron/heartbeat
  // 会话的 runContext 没有 workspace 权威，一切绝对路径写都被判 outside_project
  // （2026-10-24 e2e 实证 boundaryAskForcesConfirmation=true，其余成因 false），而用户点
  // 「允许在 <folder> 里保存文件」预先回答的恰恰是这道边界题——toolExecutor 此时打
  // forceConfirmBoundaryOnly 标记。reasonCode 只看路径，挡不住同场的其余成因（只读档、
  // guardFabric、保护路径、peer 来源、不确定目标、确认门），标记缺席一律照旧人工。
  if (!isBoundaryOnlyAsk(request)) return undefined;
  const grantSession = await scheduleWriteGrantSession(request.sessionId);
  const grantRoot = grantSession?.root;
  if (!grantRoot) {
    logger.debug('Schedule write grant not applicable (no grant on the session origin)', {
      sessionId: request.sessionId,
      type: request.type,
    });
    return undefined;
  }
  const rawTarget = request.details?.path ?? request.details?.filePath;
  if (!rawTarget) {
    logger.info('Schedule write grant declined the target (no file path on the request)', {
      sessionId: request.sessionId,
      grantRoot,
    });
    return undefined;
  }
  // 判据必须与执行侧同一份路径解析：Write/Append 落盘前走 resolveInputPath（先
  // expandTilde 再对会话工作目录归一）。`~/x` 若不先展开，会被 path.isAbsolute 判成
  // 相对路径拼进 cwd（cron 会话 cwd=授权根）恒判界内放行，而执行侧把文件写进真实
  // 家目录——授权边界与保护路径清单被 ~ 前缀整体绕过（返修 r1）。判据侧复用同一份
  // 解析器，杜绝两处再漂移；Edit 工具自身不展 tilde（落 cwd/~ 下），此处更严只影响
  // 停车与否、不产生旁路。
  const expanded = expandTilde(rawTarget);
  let target: string;
  if (path.isAbsolute(expanded)) {
    target = path.resolve(expanded);
  } else {
    const cwd = grantSession?.workingDirectory;
    if (!cwd || !path.isAbsolute(cwd)) {
      logger.info('Schedule write grant declined a relative target (session has no working directory)', {
        sessionId: request.sessionId,
        grantRoot,
        target: rawTarget,
      });
      return undefined;
    }
    target = resolveInputPath(rawTarget, cwd);
  }
  if (!isPathWithinWriteGrantRoot(target, grantRoot)) {
    logger.info('Schedule write grant declined the target (outside the granted folder)', {
      sessionId: request.sessionId,
      grantRoot,
      target,
    });
    return undefined;
  }
  // 保护路径（~/.ssh、策略文件、根内 .git/config 等约束自改写目标）不因落在授权文件夹
  // 内而放行——授权只覆盖普通文件写。projectRoot 必须带上（与执行侧同参形状）：漏了它
  // <root>/.git/config、根内数据目录策略文件等项目级条目整组漏拦（返修 r2）。会话工作
  // 目录与授权根不同时两侧都查（runContext 的 workspace 权威可能是其中任一个）。
  // 禁写名规则（.git/hooks 下新建钩子、凭据名文件，与 getForbiddenWritePathsUnderRoot
  // 同一名册）一并补拦，不要求目标已存在。
  const resolvedTarget = path.resolve(target);
  const cwdRoot = grantSession?.workingDirectory;
  if (
    isProtectedWritePath(resolvedTarget, { projectRoot: grantRoot })
    || (cwdRoot
      && path.isAbsolute(cwdRoot)
      && path.resolve(cwdRoot) !== path.resolve(grantRoot)
      && isProtectedWritePath(resolvedTarget, { projectRoot: cwdRoot }))
    || isForbiddenWriteNameUnderRoot(resolvedTarget, grantRoot)
  ) {
    logger.info('Schedule write grant declined a protected write path', { target, grantRoot });
    return undefined;
  }
  return { approved: true, approvalSource: 'schedule-write-grant' };
}

/**
 * 会话来源带授权才放行：origin.kind 只认 cron/heartbeat，授权字段只认绝对路径字符串。
 * workingDirectory 一并带回（相对路径目标的归一锚点；缺失则相对目标 fail-closed 拒）。
 * 同一次运行中途在审批卡上授权时，会话 origin 是创建时的快照、不含新授权：origin 没有授权
 * 就回查该任务的活跃定义（同一份 host 侧落库值），让同一 run 的后续写立即生效。
 */
async function scheduleWriteGrantSession(sessionId: string | undefined): Promise<
  { root: string; workingDirectory?: string } | undefined
> {
  const origin = await cronSessionOrigin(sessionId);
  if (!origin) return undefined;
  const root = origin.root ?? await liveJobGrantRoot(origin.jobId);
  return root ? { root, workingDirectory: origin.workingDirectory } : undefined;
}

interface CronSessionOrigin {
  jobId?: string;
  root?: string;
  workingDirectory?: string;
}

async function cronSessionOrigin(sessionId: string | undefined): Promise<CronSessionOrigin | undefined> {
  if (!sessionId) return undefined;
  try {
    const { getSessionManager } = await import('../services/infra/sessionManager');
    const session = await getSessionManager().getSession(sessionId).catch(() => null);
    const origin = session?.origin;
    if (origin?.kind !== 'cron' && origin?.kind !== 'heartbeat') return undefined;
    return {
      jobId: origin.id,
      root: writeGrantRootFromMetadata(origin.metadata),
      workingDirectory: session?.workingDirectory,
    };
  } catch (error) {
    logger.warn('Failed to read the session origin, treating the write scope as ungranted', { error });
    return undefined;
  }
}

async function liveJobGrantRoot(jobId: string | undefined): Promise<string | undefined> {
  if (!jobId) return undefined;
  try {
    const { getCronService } = await import('./cronService');
    return writeGrantRootFromMetadata(getCronService().getJob(jobId)?.metadata);
  } catch (error) {
    logger.warn('Failed to read the live cron job for the write grant, treating as ungranted', { jobId, error });
    return undefined;
  }
}

/** 与 approveByScheduleWriteGrant 同一条 forceConfirm 形态判据：仅 W3 写边界 ask 为唯一成因才算「授权文件夹能解的题」。 */
function isBoundaryOnlyAsk(request: {
  forceConfirm?: boolean;
  forceConfirmBoundaryOnly?: boolean;
  reasonCode?: PermissionRequestReason;
}): boolean {
  return request.forceConfirm !== true
    || (request.forceConfirmBoundaryOnly === true
      && request.reasonCode === PermissionRequestReason.FileWriteOutsideWorkspace);
}

function isSameOrInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * 「一键授权此文件夹」的候选校验：返回 realpath 后的文件夹，守卫不过返回 undefined（不出按钮、
 * 照旧逐个文件审批）。文件夹必须真实存在；不得是 $HOME 本身、文件系统根、Neo 数据目录
 * （含其内部/祖先）、或任一保护路径的祖先（~/.ssh 等所在的家目录即此类）。
 */
function guardedWriteGrantFolder(folder: string): string | undefined {
  if (!path.isAbsolute(folder)) return undefined;
  const real = realpathOrNull(folder);
  if (!real) return undefined;
  if (path.parse(real).root === real) return undefined;
  const homes = [os.homedir(), realpathOrNull(os.homedir())].filter((h): h is string => !!h);
  if (homes.some((home) => path.resolve(home) === real)) return undefined;
  const dataDir = getUserConfigDir();
  for (const dir of [path.resolve(dataDir), realpathOrNull(dataDir)]) {
    if (dir && (isSameOrInside(real, dir) || isSameOrInside(dir, real))) return undefined;
  }
  const sensitive = getSensitiveSandboxPaths();
  for (const entry of sensitive) {
    for (const candidate of [path.resolve(entry.path), realpathWithMissingTail(path.resolve(entry.path))]) {
      if (candidate && isSameOrInside(candidate, real)) return undefined;
    }
  }
  return real;
}

/**
 * 文件目标 → 候选授权文件夹：目标父目录（realpath）。目标本身是保护路径/禁写名、父目录
 * 过不了守卫都返回 undefined。只收绝对（含 ~ 展开）目标：相对目标落会话工作目录，那是
 * 「任务绑定文件夹」的老授权路径。
 */
function writeGrantFolderForTarget(rawTarget: string | undefined): string | undefined {
  if (!rawTarget) return undefined;
  const expanded = expandTilde(rawTarget);
  if (!path.isAbsolute(expanded)) return undefined;
  const realTarget = realpathWithMissingTail(path.resolve(expanded));
  if (!realTarget) return undefined;
  const folder = guardedWriteGrantFolder(path.dirname(realTarget));
  if (!folder) return undefined;
  if (isProtectedWritePath(realTarget, { projectRoot: folder }) || isForbiddenWriteNameUnderRoot(realTarget, folder)) {
    return undefined;
  }
  return folder;
}

/**
 * 停车时算出「一键授权此文件夹」候选（orchestratorPermissions 在 parkApproval 前调用，结果写进
 * 停车载荷的 writeGrantFolder）。仅无人值守 cron/heartbeat 会话、file_write/file_edit、W3 边界
 * 唯一成因、任务尚无授权时给；其余一律 undefined（按钮不出，逐文件审批照旧）。
 */
export async function writeGrantFolderForParking(request: {
  sessionId?: string;
  type: string;
  forceConfirm?: boolean;
  forceConfirmBoundaryOnly?: boolean;
  reasonCode?: PermissionRequestReason;
  details?: { path?: string; filePath?: string; [key: string]: unknown };
}): Promise<string | undefined> {
  if (request.type !== 'file_write' && request.type !== 'file_edit') return undefined;
  if (!isBoundaryOnlyAsk(request)) return undefined;
  const origin = await cronSessionOrigin(request.sessionId);
  if (!origin || origin.root || await liveJobGrantRoot(origin.jobId)) return undefined;
  return writeGrantFolderForTarget(request.details?.path ?? request.details?.filePath);
}

export type ParkedWriteFolderGrantResult =
  | { status: 'granted'; folder: string; jobId: string }
  | { status: 'kept_existing'; folder: string; existingRoot: string; jobId: string }
  | { status: 'rejected'; reason: 'not_found' | 'not_pending' | 'no_candidate' | 'folder_mismatch' | 'no_cron_origin' | 'job_missing' };

/**
 * 收件箱「一键授权此文件夹」的 host 侧：只认 requestId，文件夹从停车载荷（argsSummary 里的
 * 目标路径）重新推导并与载荷里的 writeGrantFolder 对账——不信任 renderer 传的任何路径。
 * 任务已有不同授权根时不覆盖（kept_existing，调用方仍放行本次）。落库走与 grantCronWriteScope
 * 同一条 persistJob 通道。
 */
export async function grantWriteFolderFromParkedApproval(
  requestId: string,
  deps: {
    getParkedRow: (id: string) => { kind: string; status: string; payloadJson: string } | null;
    host: CronWriteGrantHost;
  },
  updatedAt?: number,
): Promise<ParkedWriteFolderGrantResult> {
  const row = deps.getParkedRow(requestId);
  if (!row) return { status: 'rejected', reason: 'not_found' };
  if (row.kind !== 'tool_approval' || row.status !== 'pending') return { status: 'rejected', reason: 'not_pending' };
  let payload: { sessionId?: string | null; type?: string; argsSummary?: string; writeGrantFolder?: string };
  try {
    payload = JSON.parse(row.payloadJson) as typeof payload;
  } catch {
    return { status: 'rejected', reason: 'not_found' };
  }
  if ((payload.type !== 'file_write' && payload.type !== 'file_edit') || !payload.writeGrantFolder) {
    return { status: 'rejected', reason: 'no_candidate' };
  }
  const folder = writeGrantFolderForTarget(payload.argsSummary);
  if (!folder || folder !== payload.writeGrantFolder) return { status: 'rejected', reason: 'folder_mismatch' };
  const origin = await cronSessionOrigin(payload.sessionId ?? undefined);
  if (!origin) return { status: 'rejected', reason: 'no_cron_origin' };
  const jobId = origin.jobId;
  const active = jobId ? deps.host.loadActiveJob(jobId) : undefined;
  if (!jobId || !active) return { status: 'rejected', reason: 'job_missing' };
  const existingRoot = writeGrantRootFromMetadata(active.definition.metadata);
  if (existingRoot) {
    if (existingRoot === folder) return { status: 'granted', folder, jobId };
    logger.info('Write folder grant kept the existing root (not overwritten)', { jobId: jobId, existingRoot, folder });
    return { status: 'kept_existing', folder, existingRoot, jobId };
  }
  const updated: CronJobDefinition = {
    ...active.definition,
    metadata: { ...(active.definition.metadata ?? {}), [CRON_WRITE_GRANT_METADATA_KEY]: folder },
    updatedAt: updatedAt ?? Date.now(),
  };
  await deps.host.persistJob(updated);
  active.definition = updated;
  logger.info('Write scope granted from parked approval card', { jobId, root: folder, requestId });
  return { status: 'granted', folder, jobId };
}

/**
 * 授权落库后，同一会话里「同一轮并行发出、已先一步停车」的兄弟写请求（模型一次并行发 3 个
 * Write 的真实形态：3 条停车行同时落库，授权只在其中一条的卡上点）。逐条用与停车时同一套
 * 推导重算文件夹，等于刚授权的文件夹才返回——不在授权范围内的写仍留给人逐个批。
 */
export function parkedSiblingsCoveredByGrant(
  rows: Array<{ id: string; payloadJson: string }>,
  sessionId: string,
  folder: string,
  exceptRequestId: string,
): string[] {
  const covered: string[] = [];
  for (const row of rows) {
    if (row.id === exceptRequestId) continue;
    try {
      const payload = JSON.parse(row.payloadJson) as { sessionId?: string | null; type?: string; argsSummary?: string };
      if (payload.sessionId !== sessionId) continue;
      if (payload.type !== 'file_write' && payload.type !== 'file_edit') continue;
      if (writeGrantFolderForTarget(payload.argsSummary) === folder) covered.push(row.id);
    } catch {
      // 损坏的 payload 不放行
    }
  }
  return covered;
}
