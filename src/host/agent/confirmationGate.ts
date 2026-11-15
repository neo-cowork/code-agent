// ============================================================================
// Confirmation Gate - 细粒度确认门控
// ============================================================================
//
// 写操作前展示 before/after 预览 + 确认对话框，策略可配置。
// 复用现有 requestPermission 回调，扩展 PermissionRequest 类型。

import * as Diff from 'diff';
import type {
  ConfirmationPreview,
  ConfirmationContext,
  ToolConfirmationConfig,
} from '../../shared/contract/confirmation';
import { aggregateEditArgsText } from '../../shared/utils/editToolArgs';
import { canonicalizeCommand } from '../security/canonicalizeCommand';
import { isSensitiveLogKey, redactCommandSecrets } from '../security/secretRedaction';
import { isBashToolName } from '../tools/toolNames';
import { resolveSubagentUserLabel } from './resolveSubagentUserLabel';
import { resolveAgent } from './agentRegistry';

// 子代理审批：角色是否带写/执行能力，按角色真实工具表判断；未知角色按“有写权限”展示（宁多勿少）。
const SPAWN_WRITE_TOOL_PATTERN = /^(bash|write|edit|multiedit|append|notebookedit|write_file|edit_file|append_file)$/i;

function describeSpawnPermission(role: unknown): string {
  const roleId = typeof role === 'string' ? role.trim() : '';
  const agent = roleId ? resolveAgent(roleId) : undefined;
  const readOnly = agent?.readonly === true
    && !(agent.tools ?? []).some(tool => SPAWN_WRITE_TOOL_PATTERN.test(tool));
  return readOnly ? '只读查看' : '可修改文件、运行命令';
}

// 工作区内的绝对路径显示为相对路径；工作区外的路径原样保留（不得隐藏真实目标）。
const ABSOLUTE_PATH_PATTERN = /(?<![\w:./\\~-])(?:[A-Za-z]:\\|\/)[^\s"'`<>，。；：、）)\]]*/g;

function relativizeWorkspacePaths(text: string, workspaceRoot: string | undefined): string {
  const root = workspaceRoot?.replace(/[\\/]+$/, '');
  if (!root) return text;
  const normalizedRoot = root.replace(/\\/g, '/');
  return text.replace(ABSOLUTE_PATH_PATTERN, (match) => {
    const normalized = match.replace(/\\/g, '/');
    if (normalized === normalizedRoot) return './';
    if (!normalized.startsWith(`${normalizedRoot}/`)) return match;
    const rest = normalized.slice(normalizedRoot.length + 1);
    return rest ? `./${rest}` : './';
  });
}

// 危险工具列表
const DANGEROUS_TOOLS = new Set([
  'bash', 'Bash',
  'write_file', 'Write',
  'append_file', 'Append',
  'edit_file', 'Edit',
  'mail_send',
  'calendar_delete_event',
  'reminders_delete',
]);

// 高风险 bash 命令模式
const HIGH_RISK_PATTERNS = [
  /rm\s+(-r|-rf|-f)/,
  /git\s+(push|reset|rebase|merge)/,
  /sudo\s/,
  /chmod\s/,
  /chown\s/,
  /mv\s.*\//,
  />\s*\//,
  /npm\s+(publish|deprecate)/,
  /docker\s+(rm|rmi|stop|kill)/,
];

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n;]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function formatTimestamp(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return new Date(value).toLocaleString('zh-CN');
}

function pushDetail(lines: string[], label: string, value: string | null | undefined): void {
  if (!value) return;
  lines.push(`${label}: ${value}`);
}

const DEFAULT_CONFIG: ToolConfirmationConfig = {
  policy: 'ask_if_dangerous',
  overrides: {},
};

export class ConfirmationGate {
  private config: ToolConfirmationConfig;
  /** sessionId -> (toolNameOrPattern -> 批准时刻)。台账（N-PERM-GRANT-LEDGER）要显示日期。 */
  private sessionApprovals = new Map<string, Map<string, number>>();

  constructor(config?: Partial<ToolConfirmationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 判断是否需要确认
   */
  shouldConfirm(context: ConfirmationContext, sessionId: string): boolean {
    const { toolName } = context;

    // 获取该工具的策略
    const policy = this.config.overrides?.[toolName] || this.config.policy;

    switch (policy) {
      case 'always_approve':
        return false;

      case 'always_ask':
        return true;

      case 'session_approve': {
        const approved = this.sessionApprovals.get(sessionId);
        if (approved?.has(toolName)) {
          return false;
        }
        return true;
      }

      case 'ask_if_dangerous':
      default:
        return context.riskLevel === 'high';
    }
  }

  /**
   * 为工具调用构建预览信息
   */
  buildPreview(
    toolName: string,
    params: Record<string, unknown>,
    options: { workspaceRoot?: string; delegationTargetTitle?: string } = {},
  ): ConfirmationPreview | undefined {
    switch (toolName) {
      case 'edit_file':
      case 'Edit': {
        // 注册的 Edit 形状是 edits[]（multiEdit.schema.ts），归一后聚合取文；
        // legacy 平铺形状输出不变。
        const editText = aggregateEditArgsText(params);
        const oldStr = editText.oldText;
        const newStr = editText.newText;
        const filePath = (params.file_path || params.path) as string | undefined;

        if (oldStr && newStr) {
          const diff = Diff.createPatch(
            filePath || 'file',
            oldStr,
            newStr,
            'before',
            'after'
          );
          return {
            type: 'diff',
            before: oldStr.substring(0, 500),
            after: newStr.substring(0, 500),
            diff,
            summary: `编辑文件 ${filePath || '(unknown)'}`,
          };
        }
        return {
          type: 'generic',
          summary: `编辑文件 ${filePath || '(unknown)'}`,
        };
      }

      case 'write_file':
      case 'Write': {
        const filePath = (params.file_path || params.path) as string | undefined;
        const content = params.content as string | undefined;
        return {
          type: 'diff',
          after: content?.substring(0, 500),
          summary: `写入文件 ${filePath || '(unknown)'} (${content?.length || 0} 字符)`,
        };
      }

      case 'append_file':
      case 'Append': {
        const filePath = (params.file_path || params.path) as string | undefined;
        const content = params.content as string | undefined;
        return {
          type: 'diff',
          after: content?.substring(0, 500),
          summary: `追加文件 ${filePath || '(unknown)'} (${content?.length || 0} 字符)`,
        };
      }

      case 'bash':
      case 'Bash': {
        const command = params.command as string | undefined;
        return {
          type: 'command',
          summary: command?.substring(0, 200) || '(empty command)',
        };
      }

      case 'mail_draft':
      case 'mail_send': {
        const to = normalizeStringList(params.to).join(', ');
        const cc = normalizeStringList(params.cc).join(', ');
        const bcc = normalizeStringList(params.bcc).join(', ');
        const attachments = normalizeStringList(params.attachments).join(', ');
        const summary = [
          toolName === 'mail_send' ? '发送邮件' : '创建邮件草稿',
          normalizeString(params.subject) || '(无主题)',
        ].join('：');
        const details = [summary];
        pushDetail(details, 'To', to);
        pushDetail(details, 'CC', cc);
        pushDetail(details, 'BCC', bcc);
        pushDetail(details, 'Attachments', attachments);
        return {
          type: 'generic',
          summary,
          diff: details.join('\n'),
        };
      }

      case 'calendar_create_event':
      case 'calendar_update_event':
      case 'calendar_delete_event': {
        const summaryMap: Record<string, string> = {
          calendar_create_event: '创建日历事件',
          calendar_update_event: '更新日历事件',
          calendar_delete_event: '删除日历事件',
        };
        const summary = summaryMap[toolName];
        const details = [summary];
        pushDetail(details, 'Calendar', normalizeString(params.calendar));
        pushDetail(details, 'Title', normalizeString(params.title));
        pushDetail(details, 'UID', normalizeString(params.event_uid));
        pushDetail(details, 'Start', formatTimestamp(params.start_ms));
        pushDetail(details, 'End', formatTimestamp(params.end_ms));
        pushDetail(details, 'Location', normalizeString(params.location));
        return {
          type: 'generic',
          summary,
          diff: details.join('\n'),
        };
      }

      case 'reminders_create':
      case 'reminders_update':
      case 'reminders_delete': {
        const summaryMap: Record<string, string> = {
          reminders_create: '创建提醒',
          reminders_update: '更新提醒',
          reminders_delete: '删除提醒',
        };
        const summary = summaryMap[toolName];
        const details = [summary];
        pushDetail(details, 'List', normalizeString(params.list));
        pushDetail(details, 'Title', normalizeString(params.title));
        pushDetail(details, 'Reminder ID', normalizeString(params.reminder_id));
        if (typeof params.completed === 'boolean') {
          pushDetail(details, 'Completed', params.completed ? 'true' : 'false');
        }
        pushDetail(details, 'Remind At', formatTimestamp(params.remind_at_ms));
        return {
          type: 'generic',
          summary,
          diff: details.join('\n'),
        };
      }

      case 'delegate_session': {
        const toUserText = (text: string) =>
          redactCommandSecrets(relativizeWorkspacePaths(text, options.workspaceRoot)).slice(0, 200);
        const title = toUserText(normalizeString(options.delegationTargetTitle));
        const target = title ? `会话「${title}」` : '另一个会话';
        let summary: string;
        switch (params.action) {
          case 'delegate_existing': summary = `把这句话转给${target}`; break;
          case 'create_new': summary = '新建一个会话来处理这句话'; break;
          case 'correct': summary = `更正转给${target}的任务`; break;
          case 'stop': summary = `停止转给${target}的任务`; break;
          case 'resume': summary = `继续转给${target}的任务`; break;
          default: summary = `更新转给${target}的任务`;
        }
        const text = toUserText(normalizeString(params.text));
        return {
          type: 'generic', summary,
          ...(text ? { diff: `内容：${text}` } : {}),
        };
      }

      case 'spawn_agent':
      case 'AgentSpawn': {
        const toUserText = (text: string) =>
          redactCommandSecrets(relativizeWorkspacePaths(text, options.workspaceRoot)).slice(0, 200);
        const label = toUserText(resolveSubagentUserLabel(params));
        // 审批必须独立于名字披露真实任务与权限，且不打印内部角色 id。
        const details = [
          `任务：${toUserText(normalizeString(params.task))}`,
          `权限：${describeSpawnPermission(params.role)}`,
        ];
        return {
          type: 'generic',
          summary: `派出子代理：${label}`,
          diff: details.join('\n'),
        };
      }

      default: {
        const lines: string[] = [];
        for (const [key, rawValue] of Object.entries(params)) {
          if (lines.length >= 3) break;
          if (typeof rawValue !== 'string') continue;
          const trimmed = rawValue.trim();
          if (!trimmed) continue;
          const safeVal = isSensitiveLogKey(key)
            ? '***REDACTED***'
            : redactCommandSecrets(trimmed).slice(0, 120);
          lines.push(`${key}: ${safeVal}`);
        }
        return {
          type: 'generic',
          summary: `执行工具 ${toolName}`,
          ...(lines.length > 0 ? { diff: lines.join('\n') } : {}),
        };
      }
    }
  }

  /**
   * 评估工具调用的风险级别
   */
  assessRiskLevel(toolName: string, params: Record<string, unknown>): 'low' | 'medium' | 'high' {
    if (!DANGEROUS_TOOLS.has(toolName)) {
      return 'low';
    }

    if (isBashToolName(toolName)) {
      const command = (params.command as string) || '';
      const canonical = canonicalizeCommand(command);
      if (
        canonical.parsingFailed
        || HIGH_RISK_PATTERNS.some(p => p.test(canonical.command))
      ) {
        return 'high';
      }
      return 'medium';
    }

    if (toolName === 'mail_send' || toolName === 'calendar_delete_event' || toolName === 'reminders_delete') {
      return 'high';
    }

    if (
      toolName === 'mail_draft' ||
      toolName === 'calendar_create_event' ||
      toolName === 'calendar_update_event' ||
      toolName === 'reminders_create' ||
      toolName === 'reminders_update'
    ) {
      return 'medium';
    }

    if (
      toolName === 'write_file' ||
      toolName === 'Write' ||
      toolName === 'append_file' ||
      toolName === 'Append'
    ) {
      return 'medium';
    }

    if (toolName === 'edit_file' || toolName === 'Edit') {
      return 'low';
    }

    return 'low';
  }

  /**
   * 记录用户批准。approvedAt 可注入（时间戳纪律：缺省才落 Date.now()）。
   */
  recordApproval(sessionId: string, toolName: string, approvedAt: number = Date.now()): void {
    if (!this.sessionApprovals.has(sessionId)) {
      this.sessionApprovals.set(sessionId, new Map());
    }
    this.sessionApprovals.get(sessionId)!.set(toolName, approvedAt);
  }

  /** 台账消费（N-PERM-GRANT-LEDGER）：摊平列出所有会话内工具放行。 */
  listSessionApprovals(): Array<{ sessionId: string; tool: string; grantedAt: number }> {
    const items: Array<{ sessionId: string; tool: string; grantedAt: number }> = [];
    for (const [sessionId, tools] of this.sessionApprovals) {
      for (const [tool, grantedAt] of tools) {
        items.push({ sessionId, tool, grantedAt });
      }
    }
    return items;
  }

  /** 台账撤权（N-PERM-GRANT-LEDGER）：撤掉一条会话内放行，下一次同类操作重新询问。 */
  revokeSessionApproval(sessionId: string, tool: string): boolean {
    return this.sessionApprovals.get(sessionId)?.delete(tool) ?? false;
  }

  /**
   * 清除 session 的批准记录
   */
  clearSessionApprovals(sessionId: string): void {
    this.sessionApprovals.delete(sessionId);
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ToolConfirmationConfig>): void {
    Object.assign(this.config, config);
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: ConfirmationGate | null = null;

export function getConfirmationGate(config?: Partial<ToolConfirmationConfig>): ConfirmationGate {
  if (!instance) {
    instance = new ConfirmationGate(config);
  }
  return instance;
}

export function resetConfirmationGate(): void {
  instance = null;
}
