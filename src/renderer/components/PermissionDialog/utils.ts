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

// 聊天上传目录（新旧两个根）与系统临时目录：路径对用户无意义，只显示文件名。
const UPLOAD_OR_TEMP_PATH =
  /^(?:\/(?:private\/)?(?:tmp|var\/folders)\/|.*\/(?:code-agent-uploads|uploads\/[0-9a-f]{8}-[0-9a-f-]{20,})\/)/i;

// 格式化文件路径（缩短显示）
export function formatFilePath(path: string, maxLength = 60): string {
  if (UPLOAD_OR_TEMP_PATH.test(path)) {
    const name = path.split('/').filter(Boolean).pop();
    if (name) return name;
  }
  if (path.length <= maxLength) return path;

  const parts = path.split('/');
  if (parts.length <= 3) return path;

  // 保留前两部分和最后两部分
  const start = parts.slice(0, 2).join('/');
  const end = parts.slice(-2).join('/');

  return `${start}/.../${end}`;
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
