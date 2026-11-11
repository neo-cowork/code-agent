import * as os from 'node:os';
import * as path from 'node:path';
import type { ClassificationContext, ClassificationResult } from './permissionClassifier';
import { createHostReason, HostReasonCode } from '../../shared/contract/permission';
import { createTraceStep } from '../security/decisionTraceBuilder';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { isPathWithinRoot } from '../runtime/workspaceScope';
import { isProtectedWritePath } from '../sandbox/sensitivePaths';
import { CANONICAL_HOME_DIR, isPathInside } from './permissionClassifierShell';
import { GENERATOR_WRITE_TOOLS, writeTargetPathOf } from './writeTargetPath';
import { resolveToolWriteTargets } from './writeTargets';
import { requiresScheduleWriteGrant } from '../cron/cronWriteGrant';

// 写入工具名映射
const WRITE_TOOLS = new Set([
  'write_file',
  'Write',
  'append_file',
  'Append',
  'edit_file',
  'Edit',
  // 表格卡第二张工作表走 DocEdit（file_path）。它不在 Jev 扩桶里，规则落空就
  // 一律 ask；无工作区的新会话没有人点批准。与 Edit 同一条路径判据：工作区内放行，
  // 区外和受保护路径仍 ask。
  'DocEdit',
  // Office 一轮文件交付的原生生成器（output_path）。不进写入桶就落到 LLM 分类器
  // 兜底 → ask，无头新会话没人点批准（r4 实测 docx_generate 卡审批 34s 后整轮取消）。
  // 产物路径判据与 Edit 一致：工作区内放行，区外/受保护路径仍 ask。
  'docx_generate',
  'excel_generate',
]);

// 生成器类写入工具的路径是可选参数：缺省时产物落在会话工作目录（resolveInputPath
// 对 fileName 的行为），按 workingDirectory 本身参与边界判断即可。

function outsideProjectWriteAsk(
  toolName: string,
  resolved: string,
  startTime: number,
): ClassificationResult {
  const reason = `写入项目目录外: ${resolved}`;
  return {
    decision: 'ask',
    reason,
    hostReason: createHostReason(
      HostReasonCode.PermissionFileOutsideWorkspaceConfirmationRequired,
      reason,
      { toolName, path: resolved },
    ),
    confidence: 0.9,
    cached: false,
    traceStep: createTraceStep('permission_classifier', 'W3: outside_project', 'ask', reason, startTime),
    trustBoundary: true,
  };
}

function protectedWriteAsk(
  toolName: string,
  resolved: string,
  startTime: number,
): ClassificationResult {
  const reason = `protected write path requires confirmation: ${resolved}`;
  return {
    decision: 'ask',
    reason,
    hostReason: createHostReason(
      HostReasonCode.PermissionPolicyConfirmationRequired,
      reason,
      { toolName, path: resolved },
    ),
    confidence: 1,
    cached: false,
    traceStep: createTraceStep('permission_classifier', 'W0: protected_write_path', 'ask', reason, startTime),
    trustBoundary: true,
  };
}

/** The sole workspace-file approval decision, also used before executor shortcuts. */
export async function classifyFileWrite(
  toolName: string,
  args: Record<string, unknown>,
  context: ClassificationContext,
  startTime: number,
): Promise<ClassificationResult | null> {
  if (!WRITE_TOOLS.has(toolName)
    || (!context.workspaceRoot && GENERATOR_WRITE_TOOLS.has(toolName))) return null;
  const scheduled = await requiresScheduleWriteGrant(context.sessionId);
  // Keep the original lexical-path policy authoritative. The descriptor resolver
  // canonicalizes symlinks, which must not turn an in-folder escape into /tmp approval.
  const policyTarget = writeTargetPathOf(toolName, args);
  const originalPolicy = policyTarget ? classifyTarget(toolName, policyTarget, context, startTime) : undefined;
  if (originalPolicy && originalPolicy.decision !== 'approve') return { ...originalPolicy, bypassCache: scheduled };
  const assessment = scheduled && context.toolDefinition
    ? resolveToolWriteTargets({ definition: context.toolDefinition, params: args, workingDirectory: context.workingDirectory })
    : undefined;
  // Legacy callers without a definition retain their existing path semantics. Optional
  // generators have an implicit cwd destination; never use that default for malformed input.
  const fallback = !scheduled || !context.toolDefinition || (GENERATOR_WRITE_TOOLS.has(toolName) && args.output_path === undefined)
    ? writeTargetPathOf(toolName, args) : undefined;
  const targets = assessment?.targets.length ? assessment.targets : fallback ? [fallback] : [];
  if (!targets.length || assessment?.uncertain.length) {
    const reason = 'File write target is missing or uncertain';
    return { decision: 'ask', reason, confidence: 0.5, cached: false, bypassCache: scheduled,
      scheduleWriteTargets: scheduled ? [] : undefined,
      traceStep: createTraceStep('permission_classifier', 'W0: no_path', 'ask', reason, startTime) };
  }
  const results = targets.map((target) => classifyTarget(toolName, target, context, startTime));
  if (scheduled && !policyTarget) {
    const outside = results.findIndex((result) => !result.workspaceWrite);
    if (outside >= 0) return { ...outsideProjectWriteAsk(toolName, targets[outside], startTime), bypassCache: true };
  }
  const boundary = results.find((result) => result.decision !== 'approve');
  if (boundary) return { ...boundary, bypassCache: scheduled };
  const writesWorkspace = results.some((result) => result.workspaceWrite);
  if (writesWorkspace && scheduled) {
    const reason = 'Scheduled workspace file writes require an explicit folder grant';
    return { decision: 'ask', reason, confidence: 1, cached: false, bypassCache: scheduled,
      scheduleWriteTargets: targets.map((target) => path.resolve(context.workingDirectory, target)),
      traceStep: createTraceStep('permission_classifier', 'schedule_write_grant', 'ask', reason, startTime) };
  }
  const { workspaceWrite: _workspaceWrite, ...result } = results[0];
  return { ...result, bypassCache: scheduled };
}

function classifyTarget(
  toolName: string,
  filePath: string,
  context: ClassificationContext,
  startTime: number
): ClassificationResult & { workspaceWrite?: true } {
  const candidate = path.resolve(context.workingDirectory, filePath);
  const resolved = resolveCanonicalRunPath(candidate);
  const workspaceBoundary = context.workspaceRoot
    ? path.resolve(context.workspaceRoot)
    : undefined;
  const workspace = workspaceBoundary
    ? resolveCanonicalRunPath(workspaceBoundary)
    : undefined;
  if (isProtectedWritePath(resolved, { homeDir: CANONICAL_HOME_DIR, projectRoot: workspace })) {
    return protectedWriteAsk(toolName, resolved, startTime);
  }
  if (!workspaceBoundary || !workspace) return outsideProjectWriteAsk(toolName, resolved, startTime);
  if (isPathInside(resolved, workspace)) {
    return { decision: 'approve', reason: '写入项目目录内', confidence: 0.95, cached: false, workspaceWrite: true };
  }
  // Symlink that looks in-workspace but resolves outside is a boundary escape;
  // check before the /tmp allowlist so a link into /tmp cannot become implicit approval.
  if (isPathInside(candidate, workspaceBoundary)) return outsideProjectWriteAsk(toolName, resolved, startTime);
  const tmpRoot = resolveCanonicalRunPath(os.tmpdir());
  if (
    isPathWithinRoot(resolved, tmpRoot)
    || (process.platform !== 'win32' && isPathWithinRoot(resolved, '/tmp'))
  ) {
    return { decision: 'approve', reason: '写入临时目录', confidence: 0.95, cached: false };
  }
  return outsideProjectWriteAsk(toolName, resolved, startTime);
}
