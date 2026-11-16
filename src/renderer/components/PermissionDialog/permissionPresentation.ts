import type { Translations } from '../../hooks/useI18n';
import type { Language } from '../../i18n';
import type { DecisionCardViewMode } from '../DecisionCard';
import type { PermissionRequest } from './types';
import { formatFilePath, isDangerousCommand } from './utils';
import { redactCredentialText } from '@shared/security/secretPatterns';
import { PermissionRequestReason } from '@shared/contract';
import type { RmCommandTargets } from '@shared/rmCommandTargets';
import { parseRmTargets } from '@shared/rmCommandTargets';
import { browserSessionGrantEn, browserSessionGrantZh } from '../../i18n/browserSessionGrant';
import { isSandboxEscalation } from './sandboxEscalationPresentation';

function fileTarget(request: PermissionRequest): string | undefined {
  return request.details.filePath || request.details.path;
}

function basename(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/u, '');
  return normalized.split('/').pop() || target;
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

function compactFileTarget(target: string): string {
  const redacted = redactCredentialText(target);
  return isDeviceOrSpecialPath(redacted) ? redacted : basename(redacted);
}

function isOutsideWorkspace(request: PermissionRequest): boolean {
  return request.boundary?.id === 'file.external_read' || request.boundary?.id === 'file.external_write';
}

/** Display-only formatting: target identity and permission boundaries stay unchanged. */
function consequenceFileTarget(request: PermissionRequest, target: string): string {
  const redacted = redactCredentialText(target);
  if (!isOutsideWorkspace(request)) return compactFileTarget(redacted);
  const normalized = redacted.replace(/\\/g, '/');
  const homeAbbreviated = normalized.replace(/^(?:\/(?:Users|home)\/[^/]+|[a-z]:\/Users\/[^/]+)(?=\/|$)/iu, '~');
  return formatFilePath(homeAbbreviated);
}

function isDeletionRequest(request: PermissionRequest): boolean {
  const flags = request.details.commandSecurityFlags ?? [];
  return request.type === 'file_delete'
    || flags.some((flag) => /delete|sudo_rm/u.test(flag))
    || /\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/u.test(request.details.command ?? '');
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
    || request.details.sensitiveStep) return 'expanded';
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
  const compactTarget = target ? compactFileTarget(target) : undefined;
  if (
    request.reasonCode === PermissionRequestReason.UncertainWriteTargetWithPathDeny
    && !isDeletionRequest(request)
  ) {
    return p.questionUncertainWriteTarget;
  }
  switch (request.type) {
    case 'file_read':
      return compactTarget ? p.questionFileRead.replace('{target}', compactTarget) : p.questionFallback;
    case 'file_write':
      return compactTarget ? p.questionFileWrite.replace('{target}', compactTarget) : p.questionFallback;
    case 'file_edit':
      return compactTarget ? p.questionFileEdit.replace('{target}', compactTarget) : p.questionFallback;
    case 'file_delete':
      return compactTarget ? p.questionFileDelete.replace('{target}', compactTarget) : p.questionFallback;
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
  if (parsed.exact && !parsed.recursive && parsed.targets.length > 0) {
    return fileCountText(parsed.targets.length, t);
  }
  if (request.type === 'file_delete' && request.details.affectedPath) return fileCountText(1, t);
  if (parsed.targets.length > 1 || (!parsed.exact && parsed.targets.length > 0)) {
    return t.decisionCard.permission.fileCountMany;
  }
  return '';
}

export function permissionConsequence(request: PermissionRequest, t: Translations): string | undefined {
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
  const safeTarget = target ? consequenceFileTarget(request, target) : undefined;
  const deletion = isDeletionRequest(request);
  // 写入分支保持单文件口径：写类请求只动 path/filePath 指向的那一个文件。
  const writeCount = request.details.affectedFileCount ?? (safeTarget ? 1 : undefined);

  if (deletion) {
    return p.consequenceDelete
      .replace('{target}', safeTarget ?? p.targetFallback)
      .replace('{count}', deletionCountText(request, parsedRmTargets, t));
  }
  if (
    request.details.targetKind === 'device'
    && (request.type === 'file_write' || request.type === 'file_edit')
  ) {
    // Append 直写穿透：内容送达设备、节点保留；其余写类工具是原子替换，节点本身被换下。
    if (request.tool === 'Append') {
      return p.consequenceDeviceAppend.replace('{target}', safeTarget ?? p.targetFallback);
    }
    const copy = isOutsideWorkspace(request) ? p.consequenceDeviceOutside : p.consequenceDevice;
    return copy.replace('{target}', safeTarget ?? p.targetFallback);
  }
  if (request.reasonCode === PermissionRequestReason.UncertainWriteTargetWithPathDeny) {
    return p.consequenceUncertainWriteTarget;
  }
  if (request.boundary?.id === 'file.external_write') {
    return p.consequenceOutside
      .replace('{target}', safeTarget ?? p.targetFallback)
      .replace('{count}', fileCountText(writeCount, t));
  }
  if (request.details.connectorAccess?.access === 'write' || request.riskClass === 'external'
    || request.boundary?.id === 'connector.external_write'
    || (request.type === 'network' && request.details.method && !['GET', 'HEAD', 'OPTIONS'].includes(request.details.method.toUpperCase()))) {
    const endpoint = request.details.connectorAccess?.connectorName
      || request.details.url
      || p.externalServiceFallback;
    return p.consequenceNetwork.replace('{target}', redactCredentialText(endpoint));
  }
  if (request.type === 'file_write' || request.type === 'file_edit') {
    if (request.details.targetKind === 'absent') return undefined;
    return p.consequenceWrite
      .replace('{target}', safeTarget ?? p.targetFallback)
      .replace('{count}', fileCountText(writeCount, t));
  }
  return undefined;
}
