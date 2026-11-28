import type { Translations } from '../../hooks/useI18n';
import { catalogConnectorDisplayName } from '@shared/utils/catalogConnectorToolLabel';
import type { Language } from '../../i18n';
import type { DecisionCardViewMode } from '../DecisionCard';
import type { PermissionRequest } from './types';
import { formatFilePath, isDangerousCommand, type ApprovalPathContext } from './utils';
import { redactCredentialText } from '@shared/security/secretPatterns';
import { humanizeToolPath } from '@shared/utils/humanizeToolPath';
import { PermissionRequestReason } from '@shared/contract';
import type { RmCommandTargets } from '@shared/rmCommandTargets';
import { isDeleteShellCommand, parseRmTargets } from '@shared/rmCommandTargets';
import { browserSessionGrantEn, browserSessionGrantZh } from '../../i18n/browserSessionGrant';
import { isSandboxEscalation } from './sandboxEscalationPresentation';

function fileTarget(request: PermissionRequest): string | undefined {
  return request.details.filePath || request.details.path;
}

/**
 * /dev/null 的 basename 是 "null"，进标题会读成空值或普通文件名。
 * 设备节点与 DOS 保留名用完整路径展示，不当文件名截断。
 *
 * 标题是否保留完整路径。比设备白名单宽是**有意的**：多显示路径无害，少显示才误导。
 * 覆盖警告不看这条——只看 host 下发的 `details.targetKind`。
 */
function isDeviceOrSpecialPath(target: string): boolean {
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/u, '');
  const lower = normalized.toLowerCase();
  if (lower === '/dev' || lower.startsWith('/dev/')) return true;
  if (lower === '/proc' || lower.startsWith('/proc/')) return true;
  if (lower === '/private/dev' || lower.startsWith('/private/dev/')) return true;
  if (/^(nul|con|prn|aux|com[1-9]|lpt[1-9])$/i.test(normalized)) return true;
  if (/^\/\/\.\/(nul|con|prn|aux|com[1-9]|lpt[1-9])$/i.test(normalized)) return true;
  return false;
}

function compactFileTarget(target: string, p: Translations['decisionCard']['permission']): string {
  const redacted = redactCredentialText(target);
  if (isDeviceOrSpecialPath(redacted)) return redacted;

  const normalized = redacted.replace(/\\/g, '/');
  const withoutTrailingSlashes = normalized.replace(/\/+$/u, '');
  const withoutTrailingDots = withoutTrailingSlashes.replace(/(?:\/+\.)+$/u, '');
  const name = withoutTrailingDots.split('/').pop();
  if (!/^(?:\/|[a-z]:)/iu.test(normalized)) {
    if (!name || name === '.') return p.targetCurrentFolder;
    if (name === '..') {
      return /^(?:\.\/+)*\.\.$/u.test(withoutTrailingDots) ? p.targetParentFolder : withoutTrailingDots;
    }
  }
  return name || (withoutTrailingSlashes ? '/' : redacted);
}

function isOutsideWorkspace(request: PermissionRequest): boolean {
  return request.boundary?.id === 'file.external_read' || request.boundary?.id === 'file.external_write';
}

function isFlaggedOrRecursiveDeletionRequest(request: PermissionRequest): boolean {
  const flags = request.details.commandSecurityFlags ?? [];
  return request.type === 'file_delete'
    || flags.some((flag) => /delete|sudo_rm/u.test(flag))
    || /\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/u.test(request.details.command ?? '');
}

function isDeletionRequest(request: PermissionRequest): boolean {
  return isFlaggedOrRecursiveDeletionRequest(request)
    || isDeleteShellCommand(request.details.command ?? '');
}

/**
 * 安全默认的唯一判据：删除/不可逆、工作区外写入、显式警告，以及高风险命令
 * 都默认突出拒绝动作。展示层只消费结论，不再各自拼一套风险条件。
 */
export function isSafeDefaultDeny(request: PermissionRequest): boolean {
  const commandRisk = request.details.commandRiskLevel;
  return isDeletionRequest(request)
    || request.boundary?.id === 'file.external_write'
    || request.dangerLevel === 'warning'
    || request.dangerLevel === 'danger'
    || commandRisk === 'high'
    || commandRisk === 'critical';
}

/**
 * 卡片「危险红卡」判据的请求形状部分（PermissionCard 的 isDangerous 去掉 editable
 * 与 request-null 两个卡片态）。后果行的按应用抑制必须与标题/正文用同一把尺：
 * 两处各拼一套条件迟早漂移回「标题说应用、后果行说命令」。
 */
export function isDangerousRequestShape(request: PermissionRequest): boolean {
  return request.dangerLevel === 'danger'
    || request.type === 'dangerous_command'
    || (request.type === 'command' && isDangerousCommand(request.details.command));
}

/** 高危命令：卡面必须让人看见命令本身与危险标识，不能藏进折叠详情。 */
export function isHighRiskCommandRequest(request: PermissionRequest): boolean {
  const risk = request.details.commandRiskLevel;
  return request.type === 'dangerous_command'
    || request.dangerLevel === 'danger'
    || (request.type === 'command' && (risk === 'high' || risk === 'critical'));
}

function isGenericCommandRequest(request: PermissionRequest): boolean {
  return request.type === 'command'
    && request.tool.trim().toLowerCase() !== 'bash'
    // App-specific consent keeps its existing force-confirm command warning.
    && !request.details.targetApp?.name
    && !request.details.command;
}

export function defaultPermissionViewMode(request: PermissionRequest): DecisionCardViewMode {
  if (request.details.browserSessionGrant || request.rawArgs || request.details.targetApp?.name
    || isSandboxEscalation(request)
    || request.reasonCode === PermissionRequestReason.SensitiveStepHandback
    || request.details.sensitiveStep
    || isHighRiskCommandRequest(request)
    // 通用卡的问句只说「以下操作」，带参数预览的卡要批的内容就在预览里：都不能折叠。
    || isGenericCommandRequest(request)
    || request.argsPreview) return 'expanded';
  return 'compact';
}

export function permissionSummary(request: PermissionRequest, t: Translations, language: Language = 'zh'): string {
  const browser = request.details.browserSessionGrant;
  const copy = language === 'en' ? browserSessionGrantEn : browserSessionGrantZh;
  const action = copy.actions[request.details.action ?? ''];
  if (browser && action) return copy.question.replace('{action}', action)
    .replace('{site}', browser.target?.slice(browser.target.indexOf('@') + 1) ?? copy.unknownSite);

  const p = t.decisionCard.permission;
  if (isGenericCommandRequest(request)) return p.genericApprovalQuestion;
  const target = fileTarget(request);
  const compactTarget = target ? compactFileTarget(target, p) : undefined;
  // 工作区外是凭据/隐私外泄与误写的关键信号：读、写、改、删的问句都带限定，不只靠后果行。
  const qualifier = isOutsideWorkspace(request) ? p.workspaceOutsideQualifier : '';
  if (
    request.reasonCode === PermissionRequestReason.UncertainWriteTargetWithPathDeny
    && !isFlaggedOrRecursiveDeletionRequest(request)
  ) {
    return p.questionUncertainWriteTarget;
  }
  switch (request.type) {
    case 'file_read':
      return compactTarget ? p.questionFileRead.replace('{target}', `${compactTarget}${qualifier}`) : p.questionFallback;
    case 'file_write':
      return compactTarget ? p.questionFileWrite.replace('{target}', `${compactTarget}${qualifier}`) : p.questionFallback;
    case 'file_edit':
      return compactTarget ? p.questionFileEdit.replace('{target}', `${compactTarget}${qualifier}`) : p.questionFallback;
    case 'file_delete':
      return compactTarget ? p.questionFileDelete.replace('{target}', `${compactTarget}${qualifier}`) : p.questionFallback;
    case 'command':
      return p.questionCommand;
    case 'dangerous_command':
      return p.questionCommand;
    case 'network': {
      // N-HTTPREQ-CONNECTOR-CARD-DISCLOSE：连接器令牌写不是普通「访问 URL」——请求会以
      // 用户已连接应用的身份发出，问句必须点名连接器与「以你的身份」，URL 详情交给披露块。
      const connectorName = request.details.connectorTokenAttached === true && request.boundary?.connectorName
        ? (language === 'en' ? request.boundary.connectorNameEn ?? request.boundary.connectorName : request.boundary.connectorName)
        : undefined;
      if (connectorName) {
        return p.questionConnectorWrite.replace('{connector}', connectorName);
      }
      return request.details.server || request.details.toolName
        ? p.questionMcpGeneric
        : request.details.url
          ? p.questionNetwork.replace('{target}', redactCredentialText(request.details.url))
          : p.questionFallback;
    }
    case 'mcp':
      return p.questionMcpGeneric;
    default:
      return p.questionFallback;
  }
}

function fileCountText(count: number | undefined, t: Translations): string {
  if (count === undefined) return '';
  const p = t.decisionCard.permission;
  return (count === 1 ? p.fileCountOne : p.fileCount).replace('{count}', String(count));
}

/**
 * 删除后果行的文件数口径（N-FIX-APPROVAL-CARD-DELETE-COUNT-UNDERSTATED）：
 * 与宿主 details.affectedFileCount 共用 shared/rmCommandTargets 的同一套解析——
 * 宿主盘点的真实计数优先；解析确切且非递归时目标数即文件数；file_delete 工具
 * 请求单目标仍是 1。其余（通配符、变量展开、管道喂入、无宿主盘点的递归多目标）
 * 一律不写数字：能判定不止一个就改说「多个文件」，解析不出目标就什么都不写，
 * 绝不许退回误导性的「约 1 个文件」。
 */
function deletionCountText(request: PermissionRequest, parsed: RmCommandTargets, t: Translations): string {
  const hostCount = request.details.affectedFileCount;
  if (hostCount !== undefined) return fileCountText(hostCount, t);
  const emptyDirCount = parsed.emptyDirTargets ?? 0;
  const fileTargetCount = Math.max(0, parsed.targets.length - emptyDirCount);
  if (parsed.exact && !parsed.recursive && parsed.targets.length > 0) {
    return fileTargetCount > 0 ? fileCountText(fileTargetCount, t) : '';
  }
  if (request.type === 'file_delete' && request.details.affectedPath) return fileCountText(1, t);
  if (fileTargetCount > 1 || (!parsed.exact && fileTargetCount > 0)) {
    return t.decisionCard.permission.fileCountMany;
  }
  return '';
}

/** 多目标删除后果行最多点名几个目标，其余并进「等 N 个」。 */
const DELETE_NAMED_TARGET_LIMIT = 3;

/**
 * 多目标 rm 的后果句（FB-1618）：宿主的 affectedPath 只是第一个目标、计数却是全部
 * 目标之和，照抄就成了「一个名字、三个文件」。目标清单确切时按命令顺序点名前 3 个，
 * 超出的写「等 N 个」；清单不确切（混了通配符/变量/管道）时一个名字都不写——点名
 * 其中一个会被读成「只删这一个」。单目标与解析不出目标的命令返回 undefined，走原路径。
 */
function multiTargetDeletionConsequence(
  request: PermissionRequest,
  parsed: RmCommandTargets,
  t: Translations,
  pathContext?: ApprovalPathContext,
): string | undefined {
  const total = parsed.targets.length;
  if (total <= 1) return undefined;
  const p = t.decisionCard.permission;
  if (!parsed.exact) return p.consequenceDeleteUnnamed;
  const names = parsed.targets
    .slice(0, DELETE_NAMED_TARGET_LIMIT)
    .map((target) => formatFilePath(redactCredentialText(target), pathContext))
    .join(p.consequenceDeleteNameJoiner);
  const named = total > DELETE_NAMED_TARGET_LIMIT
    ? p.consequenceDeleteNamesMore
      .replace('{total}', String(total))
      .replace('{rest}', String(total - DELETE_NAMED_TARGET_LIMIT))
      .replace('{names}', () => names)
    : names;
  return p.consequenceDelete
    .replace('{target}', () => named)
    .replace('{count}', deletionCountText(request, parsed, t));
}

function formatDeletionConsequence(
  request: PermissionRequest,
  parsedRmTargets: RmCommandTargets,
  safeTarget: string | undefined,
  t: Translations,
  pathContext?: ApprovalPathContext,
): string {
  const p = t.decisionCard.permission;
  return multiTargetDeletionConsequence(request, parsedRmTargets, t, pathContext)
    ?? p.consequenceDelete
      .replace('{target}', safeTarget ?? p.targetFallback)
      .replace('{count}', deletionCountText(request, parsedRmTargets, t));
}

export function permissionConsequence(
  request: PermissionRequest,
  t: Translations,
  language: 'zh' | 'en' = 'zh',
  pathContext?: ApprovalPathContext,
): string | undefined {
  // 沙盒放宽卡的问句已经说明放开哪一个文件或目录，不再叠命令后果行。
  if (isSandboxEscalation(request)) return undefined;
  // 按应用授权卡（appGrantCard && !isDangerous，判据与 PermissionCard 同源）问的是
  // 「要不要让 Neo 操作这个应用」，命令风险后果行会把刚统一的口径撕回去：标题与
  // 正文都说应用，后果行回头说命令。该卡不渲染命令后果行——问题句已把授权语义说尽。
  if (request.details.targetApp?.name && request.forceConfirm !== true && !isDangerousRequestShape(request)) {
    return undefined;
  }
  const p = t.decisionCard.permission;
  if (isGenericCommandRequest(request)) return undefined;
  const parsedRmTargets = parseRmTargets(request.details.command ?? '');
  const target = request.details.affectedPath
    || fileTarget(request)
    || parsedRmTargets.targets[0];
  const redactedTarget = target ? redactCredentialText(target) : undefined;
  const safeTarget = redactedTarget ? formatFilePath(redactedTarget, pathContext) : undefined;
  // 写入类后果句里的上传 / 临时目录路径用位置词显示（含 .. 的路径原样）；删除后果句保持原口径。
  const humanTarget = redactedTarget ? humanizeToolPath(redactedTarget, language, request.details.pathDisplay) : undefined;
  const isHumanized = Boolean(humanTarget && redactedTarget && humanTarget !== redactedTarget);
  const writeTarget = isHumanized ? humanTarget : safeTarget;
  // 写入分支保持单文件口径：写类请求只动 path/filePath 指向的那一个文件。
  const writeCount = request.details.affectedFileCount ?? (safeTarget ? 1 : undefined);

  if (isFlaggedOrRecursiveDeletionRequest(request)) {
    return formatDeletionConsequence(request, parsedRmTargets, safeTarget, t, pathContext);
  }
  if (
    request.details.targetKind === 'device'
    && (request.type === 'file_write' || request.type === 'file_edit')
  ) {
    // Append 直写穿透：内容送达设备、节点保留；其余写类工具是原子替换，节点本身被换下。
    if (request.tool === 'Append') {
      return p.consequenceDeviceAppend.replace('{target}', writeTarget ?? p.targetFallback);
    }
    const copy = isOutsideWorkspace(request) ? p.consequenceDeviceOutside : p.consequenceDevice;
    return copy.replace('{target}', writeTarget ?? p.targetFallback);
  }
  if (request.reasonCode === PermissionRequestReason.UncertainWriteTargetWithPathDeny) {
    return p.consequenceUncertainWriteTarget;
  }
  if (request.boundary?.id === 'file.external_read') {
    return p.consequenceReadOutside.replace('{target}', target ? compactFileTarget(target, p) : p.targetFallback);
  }
  if (request.boundary?.id === 'file.external_write') {
    const template = request.details.targetKind === 'absent' ? p.consequenceOutsideNew : p.consequenceOutside;
    return template
      .replace('{target}', writeTarget ?? p.targetFallback)
      .replace('{count}', fileCountText(writeCount, t));
  }
  if (request.details.connectorAccess?.access === 'write' || request.riskClass === 'external'
    || request.boundary?.id === 'connector.external_write'
    || (request.type === 'network' && request.details.method && !['GET', 'HEAD', 'OPTIONS'].includes(request.details.method.toUpperCase()))) {
    const connector = request.details.connectorAccess;
    const endpoint = (connector && catalogConnectorDisplayName(connector.connectorId, language, connector.connectorName))
      || request.details.url
      || p.externalServiceFallback;
    return p.consequenceNetwork.replace('{target}', redactCredentialText(endpoint));
  }
  if (request.type === 'file_write' || request.type === 'file_edit') {
    if (request.details.targetKind === 'absent') return undefined;
    const compactWriteTarget = isHumanized
      ? humanTarget
      : (redactedTarget ? formatFilePath(redactedTarget, pathContext, 60) : undefined);
    return p.consequenceWrite
      .replace('{target}', compactWriteTarget ?? p.targetFallback)
      .replace('{count}', fileCountText(writeCount, t));
  }
  if (request.type === 'command' || request.type === 'dangerous_command') {
    if (isHighRiskCommandRequest(request)) return p.consequenceHighRiskCommand;
    // 分类器点了名的两类（#1611）：推到 Git 远端是外发，读凭据路径是隐私，卡面必须说出来。
    const classifierRules = request.decisionTrace?.steps.map((step) => step.rule) ?? [];
    if (classifierRules.includes('B1: sensitive_credential_read')) return p.consequenceCredentialReadCommand;
    if (classifierRules.includes('B1: git_remote_or_credential_write')) return p.consequenceGitRemoteWriteCommand;
    // 不带 -rf 的删除命令（plain rm / rm -v / rm *.log / rmdir / unlink，含 &&/; 链式调用）
    // 宿主不打删除旗标；放在高危/凭据/Git 远端三条之后，确保组合命令（如 `git push && rm a b`）
    // 不顶掉原有风险警告。
    if (isDeleteShellCommand(request.details.command ?? '')) {
      return formatDeletionConsequence(request, parsedRmTargets, safeTarget, t, pathContext);
    }
    // 其余命令（含宿主标 unknown 的——那只表示「不在已知安全名单里」，不是风险结论）不套泛泛的警告。
  }
  return undefined;
}
