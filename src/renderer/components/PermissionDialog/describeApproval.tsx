// ============================================================================
// describeApproval - 审批卡标题 / 图标 / 问句 / 后果行的唯一解析点
//
// 先把请求归到一个封闭的 kind，再对 kind 做穷尽 switch（assertNever）：
// 命令模板只属于真 shell；没人登记过文案的请求落到 generic（中性文案），
// 绝不再因为 type === 'command' 或 file_write 就借用命令/文件模板。
// 参照 openai/codex approval_overlay.rs 的穷尽 match：新增 kind 不写文案就编不过。
// ============================================================================

import React from 'react';
import { Bot, Globe, Settings2, Shield, Terminal } from 'lucide-react';
import { redactCredentialText } from '@shared/security/secretPatterns';
import type { Translations } from '../../hooks/useI18n';
import type { Language } from '../../i18n';
import type { PermissionRequest } from './types';
import { formatFilePath, getPermissionConfig } from './utils';
import { permissionConsequence, permissionSummary } from './permissionPresentation';
import { isSandboxEscalation } from './sandboxEscalationPresentation';

type ApprovalKind =
  | 'shell'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'file_delete'
  | 'network'
  | 'folder_access'
  | 'web_open'
  | 'web_action'
  | 'web_clipboard'
  | 'role_setting'
  | 'subtask'
  | 'generic';

interface ApprovalDescription {
  kind: ApprovalKind;
  title: string;
  question: string;
  consequence: string | undefined;
  icon: React.ReactElement;
  /** 浏览器会话授权专属卡（按站点命名）是否接管标题/问句/详情；站点未解析的导航走 web_open 文案。 */
  dedicatedBrowserCard: boolean;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled approval kind: ${String(value)}`);
}

const FILE_TITLE_KEY = {
  file_read: 'titleFileRead',
  file_write: 'titleFileWrite',
  file_edit: 'titleFileEdit',
  file_delete: 'titleFileDelete',
} as const;

const WEB_OPEN_ACTIONS = new Set(['open', 'navigate', 'new_tab', 'newTab']);

function isShellRequest(request: PermissionRequest): boolean {
  if (request.type === 'dangerous_command') return true;
  if (request.type !== 'command') return false;
  return request.tool.trim().toLowerCase() === 'bash'
    || Boolean(request.details.command)
    || Boolean(request.details.targetApp?.name);
}

function fileTarget(request: PermissionRequest): string | undefined {
  return request.details.filePath || request.details.path;
}

function classify(request: PermissionRequest): ApprovalKind {
  const tool = request.tool.trim();
  const lower = tool.toLowerCase();
  if (lower === 'set_role_proactivity') return 'role_setting';
  if (lower === 'spawn_agent' || lower === 'agentspawn') return 'subtask';
  if (/^browser(?:$|[_.])/u.test(lower)) {
    const action = String(request.details.action ?? '');
    if (action === 'write_clipboard') return 'web_clipboard';
    return request.details.url && (!action || WEB_OPEN_ACTIONS.has(action)) ? 'web_open' : 'web_action';
  }
  if (request.type === 'directory_access') return request.details.path ? 'folder_access' : 'generic';
  if (isShellRequest(request)) return 'shell';
  switch (request.type) {
    case 'file_read':
    case 'file_write':
    case 'file_edit':
    case 'file_delete':
      // 没有文件目标的「文件类」请求只是 permissionLevel 推断出来的类型，不是真文件操作。
      return fileTarget(request) ? request.type : 'generic';
    case 'network':
    case 'mcp':
      return 'network';
    default:
      return 'generic';
  }
}

function folderConsequence(request: PermissionRequest, p: Translations['decisionCard']['permission']): string {
  const access = request.details.requestedAccess ?? request.details.access;
  const copy = access === 'read_write'
    ? p.consequenceFolderReadWrite
    : access === 'read_only'
      ? p.consequenceFolderReadOnly
      : p.consequenceFolderUnknown;
  const target = formatFilePath(redactCredentialText(request.details.path ?? ''));
  return copy.replace('{target}', target);
}

/** 宿主 reason 里带内部标识（snake_case / 默认的 "protocol tool X"）时不上卡。 */
function userFacingReason(reason: string | undefined): string | undefined {
  const text = reason?.trim();
  if (!text || /^protocol tool /u.test(text) || /\b[a-z]+(?:_[a-z]+)+\b/u.test(text)) return undefined;
  return redactCredentialText(text);
}

function iconFor(kind: ApprovalKind, request: PermissionRequest): React.ReactElement {
  switch (kind) {
    case 'shell':
      return React.createElement(Terminal, { size: 20 });
    case 'file_read':
    case 'file_write':
    case 'file_edit':
    case 'file_delete':
      return getPermissionConfig(kind).icon as React.ReactElement;
    case 'network':
      return getPermissionConfig(request.type).icon as React.ReactElement;
    case 'folder_access':
      return getPermissionConfig('directory_access').icon as React.ReactElement;
    case 'web_open':
    case 'web_action':
    case 'web_clipboard':
      return React.createElement(Globe, { size: 20 });
    case 'role_setting':
      return React.createElement(Settings2, { size: 20 });
    case 'subtask':
      return React.createElement(Bot, { size: 20 });
    case 'generic':
      return React.createElement(Shield, { size: 20 });
    default:
      return assertNever(kind);
  }
}

export function describeApproval(
  request: PermissionRequest,
  t: Translations,
  language: Language = 'zh',
): ApprovalDescription {
  const described = describeKind(request, t, language);
  const grant = request.details.browserSessionGrant;
  // 站点已解析的授权卡（按站点问句）保持专属文案；站点未解析的网页导航只说「访问这个网址」，
  // 不再借专属卡的「无法确认当前网站」。
  const dedicatedBrowserCard = Boolean(grant) && !(described.kind === 'web_open' && !grant?.target);
  return dedicatedBrowserCard
    ? { ...described, question: permissionSummary(request, t, language), dedicatedBrowserCard }
    : { ...described, dedicatedBrowserCard };
}

function describeKind(
  request: PermissionRequest,
  t: Translations,
  language: Language,
): Omit<ApprovalDescription, 'dedicatedBrowserCard'> {
  const kind = classify(request);
  const p = t.decisionCard.permission;
  const icon = iconFor(kind, request);
  const url = request.details.url ? redactCredentialText(request.details.url) : undefined;
  const reasonLine = (text: string): string => {
    const reason = userFacingReason(request.reason);
    return reason ? `${text}\n${p.reasonLine.replace('{reason}', reason)}` : text;
  };
  const genericConsequence = p.genericApprovalDescription;
  // 沙盒放宽卡的问句已把话说完，不叠后果行（与 permissionConsequence 同口径）。
  const quiet = (text: string | undefined): string | undefined => (isSandboxEscalation(request) ? undefined : text);

  switch (kind) {
    case 'shell':
    case 'file_read':
    case 'file_write':
    case 'file_edit':
    case 'file_delete':
    case 'network': {
      const title = kind === 'shell' || kind === 'network'
        ? getPermissionConfig(request.type).title
        : p[FILE_TITLE_KEY[kind]];
      return {
        kind,
        title,
        question: permissionSummary(request, t, language),
        consequence: permissionConsequence(request, t),
        icon,
      };
    }
    case 'folder_access':
      return {
        kind,
        title: p.titleFolderAccess,
        question: p.questionFolderAccess,
        consequence: reasonLine(folderConsequence(request, p)),
        icon,
      };
    case 'web_open':
      return {
        kind,
        title: p.titleWebOpen,
        question: url ? p.questionNetwork.replace('{target}', url) : p.genericApprovalQuestion,
        consequence: url ? p.consequenceWebOpen.replace('{target}', url) : genericConsequence,
        icon,
      };
    case 'web_action':
      return { kind, title: p.titleWebAction, question: p.questionWebAction, consequence: p.consequenceWebAction, icon };
    case 'web_clipboard':
      return { kind, title: p.titleWebClipboard, question: p.questionWebClipboard, consequence: p.consequenceWebClipboard, icon };
    case 'role_setting':
      return {
        kind,
        title: p.titleRoleSetting,
        question: p.questionRoleSetting,
        // 旧 -> 新复述只由详情区的 preview.summary 展示一次；没有 preview 才退回宿主 reason。
        consequence: request.details.preview?.summary ? undefined : userFacingReason(request.reason),
        icon,
      };
    case 'subtask':
      return { kind, title: p.titleSubtask, question: p.questionSubtask, consequence: genericConsequence, icon };
    case 'generic':
      return {
        kind,
        title: p.genericApprovalTitle,
        question: p.genericApprovalQuestion,
        consequence: quiet(genericConsequence),
        icon,
      };
    default:
      return assertNever(kind);
  }
}
