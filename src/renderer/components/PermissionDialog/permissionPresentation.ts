import React from 'react';
import { Bot, Clipboard, Globe, Settings2, ShieldCheck } from 'lucide-react';
import type { Translations } from '../../hooks/useI18n';
import type { Language } from '../../i18n';
import type { DecisionCardViewMode } from '../DecisionCard';
import type { PermissionRequest } from './types';
import { formatFilePath, isDangerousCommand } from './utils';
import { redactCredentialText } from '@shared/security/secretPatterns';
import { PermissionRequestReason } from '@shared/contract';
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

const SHELL_TOOL_NAMES = new Set([
  'bash',
  'process',
  'grep',
  'glob',
  'git_diff',
  'git_commit',
  'git_worktree',
  'kill_shell',
  'task_output',
]);

function isShellAction(request: PermissionRequest): boolean {
  if (typeof request.details.command === 'string' && request.details.command.trim() !== '') return true;
  const tool = request.tool.trim().toLowerCase();
  return SHELL_TOOL_NAMES.has(tool)
    || tool.startsWith('terminal_')
    || tool.startsWith('shell_')
    || tool.startsWith('acp:terminal/');
}

/** Conservative display labels only; never changes approval policy or risk classification. */
export function shellActionPresentation(request: PermissionRequest, t: Translations): { title: string; consequence: string } | undefined {
  if (!isShellAction(request) || isDangerousRequestShape(request) || isSafeDefaultDeny(request)) return undefined;
  const command = request.details.command?.trim() ?? '';
  // Compound syntax and substitutions keep their full command review.
  if (/[;&|`$<>\n\r]/u.test(command)) return undefined;
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/gu)?.map((token) => token.replace(/^['"]|['"]$/gu, '')) ?? [];
  const p = t.decisionCard.permission;
  if (tokens[0] === 'lsof' && tokens.slice(1).every((token) =>
    /^(?:-[nP]+|-i(?:TCP|UDP)?(?::[\w.-]+)?|-sTCP:(?:LISTEN|ESTABLISHED)|-p\d+|:\d+|\/[^-].*)$/u.test(token))) {
    return { title: p.titleInspectProcesses, consequence: p.consequenceInspectProcesses };
  }
  if (tokens[0] !== 'curl') return undefined;
  let url: string | undefined;
  let output: string | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-o' || token === '--output') {
      output = tokens[++i];
      if (!output || output.startsWith('-')) return undefined;
    } else if (/^https?:\/\//u.test(token) && !url) {
      url = token;
    } else if (!/^(?:-[LsSf]+|--location|--silent|--show-error|--fail)$/u.test(token)) {
      return undefined;
    }
  }
  if (!url || !output) return undefined;
  return {
    title: p.titleDownloadPage,
    consequence: p.consequenceDownloadPage.replace('{url}', redactCredentialText(url)).replace('{file}', formatFilePath(redactCredentialText(output))),
  };
}

type NonShellPresentationKey = 'browser' | 'browserAction' | 'roleProactivity' | 'spawnAgent' | 'browserClipboardWrite';

function nonShellPresentationKey(request: PermissionRequest): NonShellPresentationKey | undefined {
  const tool = request.tool.trim().toLowerCase();
  if (tool === 'browser_navigate') return 'browser';
  if (tool === 'browser' || tool === 'browser_action') {
    // 标题必须跟实际动作走：只有导航叫「打开网页」，点击/填写/提交不能冒充。
    return request.details.action === 'navigate' ? 'browser' : 'browserAction';
  }
  if (tool === 'set_role_proactivity') return 'roleProactivity';
  if (tool === 'spawn_agent' || tool === 'agentspawn') return 'spawnAgent';
  if (tool === 'browser_action.write_clipboard' || tool === 'write_clipboard') return 'browserClipboardWrite';
  return undefined;
}

function hasFileTarget(request: PermissionRequest): boolean {
  return Boolean(fileTarget(request) || request.details.affectedPath);
}

function isNonShellRequest(request: PermissionRequest): boolean {
  if (isShellAction(request)) return false;
  if (request.type === 'command' || request.type === 'dangerous_command') return true;
  // 文件类请求却没有任何文件目标：非文件工具借了文件模板（如 TaskManager 按 write 级别走 file_write），
  // 展开会写成「创建文件」。带目标的真文件工具与「写入目标不确定」卡不动。
  return (request.type === 'file_read' || request.type === 'file_write' || request.type === 'file_edit')
    && !hasFileTarget(request)
    && request.reasonCode !== PermissionRequestReason.UncertainWriteTargetWithPathDeny;
}

function safeNonShellDetail(request: PermissionRequest): string | undefined {
  // RequestDetails 已渲染 details.preview.summary；host 常把同一句同时写进 reason，
  // 后果行再复述就是同一行出现两次。
  const candidate = request.reason?.trim();
  if (!candidate) return undefined;
  if (candidate === request.details.preview?.summary?.trim()) return undefined;
  if (/命令|command|覆盖本机系统|overwrite local system/iu.test(candidate)) return undefined;
  if (request.type === 'file_read' && /写入|覆盖|write|overwrite/iu.test(candidate)) return undefined;
  return candidate;
}

/**
 * host 的确认门控对没有专属摘要的工具兜底写 `执行工具 <tool>`（confirmationGate 的 default 分支）。
 * 它只是内部工具名，不是给用户看的摘要，详情区不渲染。
 */
export function isHostDefaultToolPreview(request: PermissionRequest): boolean {
  return request.details.preview?.summary?.trim() === `执行工具 ${request.tool}`;
}

/** Icon override so non-shell cards do not wear the shell terminal icon. Shell cards keep the config icon. */
export function permissionIcon(request: PermissionRequest): React.ReactElement | undefined {
  if (!isNonShellRequest(request)) return undefined;
  const key = nonShellPresentationKey(request);
  const Icon = key === 'browser' || key === 'browserAction' ? Globe
    : key === 'roleProactivity' ? Settings2
    : key === 'spawnAgent' ? Bot
    : key === 'browserClipboardWrite' ? Clipboard
    : ShieldCheck;
  return React.createElement('span', { 'data-testid': 'permission-action-icon' }, React.createElement(Icon, { size: 20 }));
}

/** Title override for command-shaped requests that are not shell actions. */
export function permissionTitle(request: PermissionRequest, t: Translations): string | undefined {
  const shell = shellActionPresentation(request, t);
  if (shell) return shell.title;
  if (request.type === 'file_read' && hasFileTarget(request)) return t.decisionCard.permission.titleReadFile;
  if (!isNonShellRequest(request)) return undefined;
  const p = t.decisionCard.permission;
  switch (nonShellPresentationKey(request)) {
    case 'browser':
      return p.titleBrowserNavigation;
    case 'browserAction':
      return p.titleBrowserAction;
    case 'roleProactivity':
      return p.titleRoleProactivity;
    case 'spawnAgent':
      return p.titleSpawnAgent;
    case 'browserClipboardWrite':
      return p.titleBrowserClipboardWrite;
    default:
      return p.titleAction;
  }
}

function nonShellConsequence(request: PermissionRequest, t: Translations): string {
  const p = t.decisionCard.permission;
  switch (nonShellPresentationKey(request)) {
    case 'browser': {
      const url = request.details.url?.trim();
      return url
        ? p.consequenceBrowserVisit.replace('{target}', redactCredentialText(url))
        : p.consequenceAction;
    }
    case 'browserAction':
      return p.consequenceBrowserAction;
    case 'roleProactivity':
      return safeNonShellDetail(request) ?? p.consequenceAction;
    case 'spawnAgent':
      return safeNonShellDetail(request) ?? p.consequenceSpawnAgent;
    case 'browserClipboardWrite':
      return p.consequenceBrowserClipboardWrite;
    default:
      return safeNonShellDetail(request) ?? p.consequenceAction;
  }
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

export function isGenericCommandRequest(request: PermissionRequest): boolean {
  return request.type === 'command'
    && request.tool.trim().toLowerCase() !== 'bash'
    // App-specific consent keeps its existing force-confirm command warning.
    && !request.details.targetApp?.name
    && !request.details.command;
}

export function defaultPermissionViewMode(request: PermissionRequest): DecisionCardViewMode {
  if (request.details.browserSessionGrant) return 'expanded';
  if (request.rawArgs || isOutsideWorkspace(request) || isSafeDefaultDeny(request)) return 'expanded';
  return request.type === 'file_read' || request.type === 'file_write' || request.type === 'file_edit'
    ? 'compact'
    : 'expanded';
}

export function permissionSummary(request: PermissionRequest, t: Translations, language: Language = 'zh'): string {
  const browser = request.details.browserSessionGrant;
  const copy = language === 'en' ? browserSessionGrantEn : browserSessionGrantZh;
  const action = copy.actions[request.details.action ?? ''];
  if (browser && action) return copy.question.replace('{action}', action)
    .replace('{site}', browser.target?.slice(browser.target.indexOf('@') + 1) ?? copy.unknownSite);

  const p = t.decisionCard.permission;
  if (shellActionPresentation(request, t)) return p.questionAction;
  const target = fileTarget(request);
  const compactTarget = target ? compactFileTarget(target) : undefined;
  const qualifier = isOutsideWorkspace(request) ? `（${p.workspaceOutside}）` : '';
  if (isNonShellRequest(request)) return p.questionAction;
  if (
    request.reasonCode === PermissionRequestReason.UncertainWriteTargetWithPathDeny
    && !isDeletionRequest(request)
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
  return t.decisionCard.permission.fileCount.replace('{count}', String(count));
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
  if (isNonShellRequest(request)) return nonShellConsequence(request, t);
  const p = t.decisionCard.permission;
  const shell = shellActionPresentation(request, t);
  if (shell) return shell.consequence;
  const commandDeleteTarget = request.details.command?.match(/\brm\s+(?:(?:-[^\s]+|--[^\s]+)\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/u);
  const target = request.details.affectedPath
    || fileTarget(request)
    || commandDeleteTarget?.[1]
    || commandDeleteTarget?.[2]
    || commandDeleteTarget?.[3];
  const safeTarget = target ? formatFilePath(redactCredentialText(target)) : undefined;
  const count = request.details.affectedFileCount ?? (safeTarget ? 1 : undefined);
  const deletion = isDeletionRequest(request);

  if (deletion) {
    return p.consequenceDelete
      .replace('{target}', safeTarget ?? p.targetFallback)
      .replace('{count}', fileCountText(count, t));
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
  if (isOutsideWorkspace(request)) {
    const outsideCopy = request.type === 'file_read' ? p.consequenceReadOutside : p.consequenceOutside;
    return outsideCopy
      .replace('{target}', safeTarget ?? p.targetFallback)
      .replace('{count}', fileCountText(count, t));
  }
  if (request.type === 'network' || request.type === 'mcp') {
    const endpoint = request.details.url
      || [request.details.server, request.details.toolName].filter(Boolean).join(' / ')
      || p.externalServiceFallback;
    return p.consequenceNetwork.replace('{target}', redactCredentialText(endpoint));
  }
  if (request.type === 'file_write' || request.type === 'file_edit') {
    return p.consequenceWrite
      .replace('{target}', safeTarget ?? p.targetFallback)
      .replace('{count}', fileCountText(count, t));
  }
  if (request.type === 'command' || request.type === 'dangerous_command') {
    const risk = request.details.commandRiskLevel ?? (request.dangerLevel === 'danger' ? 'high' : 'medium');
    if (risk === 'critical' || risk === 'high') return p.consequenceHighRiskCommand;
    const classifierRules = request.decisionTrace?.steps.map((step) => step.rule) ?? [];
    if (classifierRules.includes('B1: sensitive_credential_read')) return p.consequenceCredentialReadCommand;
    if (classifierRules.includes('B1: git_remote_or_credential_write')) return p.consequenceGitRemoteWriteCommand;
    return risk === 'unknown'
      ? p.consequenceUnknownRiskCommand
      : p.consequenceRiskCommand;
  }
  return undefined;
}
