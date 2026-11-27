// ============================================================================
// PermissionDialog - Utility Functions
// ============================================================================

import React from 'react';
import {
  FileText,
  FileEdit,
  FilePlus,
  Trash2,
  Terminal,
  Globe,
  MessageSquare,
  AlertTriangle,
  FolderOpen,
  Shield,
} from 'lucide-react';
import type { Translations } from '../../hooks/useI18n';
import type { PermissionType, PermissionConfig } from './types';
import { formatPathForDisplay } from '../../utils/formatPathForDisplay';

/** 卡片类型标题的唯一出口：全部走 i18n，utils 里不留任何语言字面量；未登记类型落中性标题。 */
export function getPermissionTitle(type: PermissionType, p: Translations['decisionCard']['permission']): string {
  switch (type) {
    case 'file_read': return p.titleFileRead;
    case 'file_write': return p.titleFileWrite;
    case 'file_edit': return p.titleFileEdit;
    case 'file_delete': return p.titleFileDelete;
    case 'command': return p.titleCommand;
    case 'dangerous_command': return p.titleDangerousCommand;
    case 'network': return p.titleNetwork;
    case 'mcp': return p.titleMcp;
    case 'directory_access': return p.titleFolderAccess;
    default: return p.genericApprovalTitle;
  }
}

// 权限配置映射
export function getPermissionConfig(type: PermissionType): PermissionConfig {
  const configs: Record<PermissionType, PermissionConfig> = {
    file_read: {
      icon: React.createElement(FileText, { size: 20 }),
      color: 'text-badge-info',
      bgColor: 'bg-blue-500/10',
      borderColor: 'border-badge-info/30',
    },
    file_write: {
      icon: React.createElement(FilePlus, { size: 20 }),
      color: 'text-badge-success',
      bgColor: 'bg-green-500/10',
      borderColor: 'border-badge-success/30',
    },
    file_edit: {
      icon: React.createElement(FileEdit, { size: 20 }),
      color: 'text-badge-warning',
      bgColor: 'bg-yellow-500/10',
      borderColor: 'border-badge-warning/30',
    },
    file_delete: {
      icon: React.createElement(Trash2, { size: 20 }),
      color: 'text-badge-danger',
      bgColor: 'bg-red-500/10',
      borderColor: 'border-red-500/30',
    },
    command: {
      icon: React.createElement(Terminal, { size: 20 }),
      color: 'text-badge-accent',
      bgColor: 'bg-purple-500/10',
      borderColor: 'border-badge-accent/30',
    },
    dangerous_command: {
      icon: React.createElement(AlertTriangle, { size: 20 }),
      color: 'text-badge-danger',
      bgColor: 'bg-red-500/10',
      borderColor: 'border-red-500/30',
    },
    network: {
      icon: React.createElement(Globe, { size: 20 }),
      color: 'text-badge-info',
      bgColor: 'bg-badge-info',
      borderColor: 'border-badge-info/30',
    },
    mcp: {
      icon: React.createElement(MessageSquare, { size: 20 }),
      color: 'text-badge-accent',
      bgColor: 'bg-indigo-500/10',
      borderColor: 'border-badge-accent/30',
    },
    directory_access: {
      icon: React.createElement(FolderOpen, { size: 20 }),
      color: 'text-badge-info',
      bgColor: 'bg-blue-500/10',
      borderColor: 'border-badge-info/30',
    },
  };

  // 未登记的类型绝不借用命令模板（终端图标 + 「执行命令」）。
  return configs[type] ?? NEUTRAL_PERMISSION_CONFIG;
}

const NEUTRAL_PERMISSION_CONFIG: PermissionConfig = {
  icon: React.createElement(Shield, { size: 20 }),
  color: 'text-badge-info',
  bgColor: 'bg-blue-500/10',
  borderColor: 'border-badge-info/30',
};

// 危险命令检测模式
const DANGEROUS_PATTERNS = [
  // 删除相关
  /rm\s+-rf/i,
  /rm\s+.*--no-preserve-root/i,
  /sudo\s+rm/i,
  /rm\s+-r\s+\/(?!\w)/i, // rm -r / 但不匹配 rm -r /path

  // 磁盘操作
  /mkfs/i,
  /dd\s+if=/i,
  />\s*\/dev\/sd/i,
  />\s*\/dev\/nvme/i,

  // 权限相关
  /chmod\s+777/i,
  /chmod\s+-R\s+777/i,
  /chown\s+-R\s+root/i,

  // 危险的 shell 模式
  /:(){:|:&};:/,  // fork bomb
  /\|\s*xargs\s+rm/i,

  // 网络下载执行
  /curl.*\|\s*(ba)?sh/i,
  /wget.*\|\s*(ba)?sh/i,
  /curl.*\|\s*python/i,
  /wget.*\|\s*python/i,

  // 系统文件修改
  />\s*\/etc\/passwd/i,
  />\s*\/etc\/shadow/i,
  />\s*\/etc\/sudoers/i,

  // 强制覆盖
  /mv\s+-f\s+.*\s+\/bin/i,
  /mv\s+-f\s+.*\s+\/usr/i,

  // 数据库危险操作
  /DROP\s+DATABASE/i,
  /DROP\s+TABLE/i,
  /TRUNCATE\s+TABLE/i,
  /DELETE\s+FROM\s+\w+\s*;?\s*$/i, // DELETE FROM table 无 WHERE
];

// 检测命令是否危险
export function isDangerousCommand(command?: string): boolean {
  if (!command) return false;
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

export interface ApprovalPathContext {
  workspaceRoot?: string | null;
  homeDir?: string | null;
}

/**
 * 审批卡的 `./` 相对路径只允许相对「该请求所属会话」自己的工作目录，绝不借用当前 UI 恰好打开的
 * 其他会话目录。会话不在列表里时，仅当请求明确归属当前会话才回落到 appStore.workingDirectory；
 * 归属未知或属于别的会话时返回 null（不做相对化）。
 */
export function resolveApprovalWorkspaceRoot(params: {
  requestSessionId?: string | null;
  sourceSessionId?: string | null;
  currentSessionId?: string | null;
  sessions?: ReadonlyArray<{ id: string; workingDirectory?: string | null }>;
  appWorkingDirectory?: string | null;
}): string | null {
  const ownSessionId = params.requestSessionId ?? params.sourceSessionId ?? null;
  if (!ownSessionId) return null;
  const matched = params.sessions?.find((session) => session.id === ownSessionId);
  if (matched) return matched.workingDirectory ?? null;
  if (params.currentSessionId && ownSessionId === params.currentSessionId) {
    return params.appWorkingDirectory ?? null;
  }
  return null;
}

/**
 * 审批面路径的唯一格式化出口（文件行、后果句、文件夹授权、沙盒被拦路径共用同一口径）：
 * 工作区内 → ./相对；宿主真实家目录下 → ~/…（未知时不折）；其余 → 完整绝对路径（永不缩成 parent/file）。
 */
export function formatFilePath(path: string, context: ApprovalPathContext = {}, maxLength?: number): string {
  return formatPathForDisplay(path, {
    workspaceRoot: context.workspaceRoot,
    homeDir: context.homeDir,
    keepLocation: true,
    maxLength,
  });
}

// 解析命令获取基础命令名
export function getBaseCommand(command?: string): string {
  if (!command) return '';

  // 去除 sudo 前缀
  const withoutSudo = command.replace(/^sudo\s+/, '');

  // 获取第一个命令（处理管道）
  const firstCommand = withoutSudo.split('|')[0].trim();

  // 获取基础命令名
  const parts = firstCommand.split(/\s+/);
  return parts[0] || '';
}
