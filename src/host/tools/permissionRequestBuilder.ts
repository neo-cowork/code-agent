// ============================================================================
// Permission Request Builder - approval-card request construction and file
// boundary classification (moved verbatim out of toolExecutor.ts)
// ============================================================================

import * as nodePath from 'path';
import type { ToolDefinition } from '../../shared/contract';
import type { PermissionBoundaryId } from '../../shared/contract/permissionBoundary';
import { PermissionRequestReason } from '../../shared/contract/permission';
import { aggregateEditArgsText } from '../../shared/utils/editToolArgs';
import type { ValidationResult } from '../security';
import { isRunPathInsideWorkspace, type RunContext } from '../runtime/runContext';
import { resolveWorkspacePath } from '../runtime/workspaceScope';
import { connectorWritePermissionRequest } from './connectorTokenWrite';
import { eventReplyPermissionRequest } from './eventReplySession';
import { buildTerminalApprovalPreview } from './modules/terminal/terminalApprovalPreview';
import { boundaryIdForRequestType } from './permissionBoundaryMapping';
import { permissionRequestTypeForLevel } from './permissionRequestType';
import { isDangerousCommand } from './toolExecutorHelpers';
import type { PermissionRequestData } from './types';

/**
 * 审批请求构造需要读取的执行上下文——原 ToolExecutor 实例状态
 * （runContext / executionCwd / runtimeWorkspace）下放为显式参数。
 */
export interface PermissionRequestBuilderContext {
  runContext?: RunContext;
  executionCwd: string;
  runtimeWorkspace: string;
}

export function buildPermissionRequest(
  context: PermissionRequestBuilderContext,
  tool: ToolDefinition,
  params: Record<string, unknown>,
  commandValidation?: ValidationResult,
  commandRiskOverride?: ValidationResult['riskLevel'] | 'unknown',
  sessionId?: string,
): PermissionRequestData {
  const sourceAttribution = (rawPath?: unknown): Record<string, unknown> => {
    const workspaceScope = context.runContext?.workspaceScope;
    if (!workspaceScope) return {};
    const candidate = typeof rawPath === 'string' && rawPath.trim()
      ? (nodePath.isAbsolute(rawPath)
        ? nodePath.resolve(rawPath)
        : nodePath.resolve(context.executionCwd, rawPath))
      : context.executionCwd;
    const match = resolveWorkspacePath(workspaceScope, candidate, 'read');
    if (!match) return { workspaceScopeVersion: workspaceScope.version };
    return {
      projectId: workspaceScope.projectId,
      sourceId: match.root.sourceId,
      sourceRole: match.root.role,
      sourceAccess: match.root.access,
      relativePathWithinSource: match.relativePath,
      workspaceScopeVersion: workspaceScope.version,
    };
  };
  switch (tool.name) {
    case 'bash':
    case 'Bash':
      return {
        type: isDangerousCommand(params.command as string)
          ? 'dangerous_command'
          : 'command',
        tool: tool.name,
        details: {
          command: params.command,
          commandRiskLevel: commandRiskOverride ?? commandValidation?.riskLevel,
          commandSecurityFlags: commandValidation?.securityFlags,
          ...sourceAttribution(params.working_directory),
        },
        reason: commandValidation?.reason ?? 'Execute shell command',
        reasonCode: PermissionRequestReason.ShellHighRisk,
        boundary: {
          id: 'command.shell',
          reason: '本次命令会在当前工作区的 shell 环境执行。',
        },
      };

    case 'read_file':
    case 'Read':
      return {
        type: 'file_read',
        tool: tool.name,
        details: { path: params.file_path, ...sourceAttribution(params.file_path) },
        boundary: {
          id: getFileBoundaryId(context, params.file_path, false),
          reason: '读取文件内容用于完成当前任务。',
        },
      };

    case 'write_file':
    case 'Write':
      return {
        type: 'file_write',
        tool: tool.name,
        details: {
          path: params.file_path,
          contentLength: (params.content as string)?.length || 0,
          ...sourceAttribution(params.file_path),
        },
        reasonCode: fileWriteReasonCode(context, params.file_path),
        boundary: {
          id: getFileBoundaryId(context, params.file_path, true),
          reason: '写入文件内容会修改目标路径。',
        },
      };

    case 'append_file':
    case 'Append':
      return {
        type: 'file_write',
        tool: tool.name,
        details: {
          path: params.file_path,
          contentLength: (params.content as string)?.length || 0,
          final: params.final === true,
          ...sourceAttribution(params.file_path),
        },
        reasonCode: fileWriteReasonCode(context, params.file_path),
        boundary: {
          id: getFileBoundaryId(context, params.file_path, true),
          reason: '追加内容会修改目标路径。',
        },
      };

    case 'edit_file':
    case 'Edit': {
      // 注册的 Edit 形状是 edits[]（multiEdit.schema.ts），归一后聚合取文；
      // legacy 平铺形状输出不变。
      const editText = aggregateEditArgsText(params);
      return {
        type: 'file_edit',
        tool: tool.name,
        details: {
          path: params.file_path,
          oldString: editText.oldText || undefined,
          newString: editText.newText || undefined,
          ...sourceAttribution(params.file_path),
        },
        reasonCode: fileWriteReasonCode(context, params.file_path),
        boundary: {
          id: getFileBoundaryId(context, params.file_path, true),
          reason: '编辑操作会修改目标文件内容。',
        },
      };
    }

    case 'web_fetch':
    case 'WebFetch':
    case 'web_search':
    case 'WebSearch':
      return {
        type: 'network',
        tool: tool.name,
        details: { url: params.url, query: params.query },
        reasonCode: PermissionRequestReason.NetworkEgress,
        boundary: {
          id: 'network.web_request',
          reason: '本次工具会访问外部网络资源。',
        },
      };

    case 'mcp':
    case 'MCPUnified':
    case 'mcp_read_resource':
      return {
        type: 'network',
        tool: tool.name,
        details: {
          server: params.server,
          tool: params.tool,
          toolName: params.tool,
          uri: params.uri,
        },
        reason: `调用 MCP 服务器 ${params.server}`,
        reasonCode: PermissionRequestReason.McpTool,
        boundary: {
          id: 'mcp.server_tool',
          reason: `调用 MCP 服务器 ${params.server}`,
        },
      };

    default: {
      // 连接器写回与 http_request 令牌写共用 connector.external_write 边界（构造见 connectorTokenWrite.ts）。
      const connectorRequest = connectorWritePermissionRequest(tool, params);
      if (connectorRequest) return connectorRequest;
      // 事件回复（N-TRIGGER-OBSERVE-ACTION-CONTRACT-DESIGN）：卡上点名宿主绑定的目的地与回复正文（构造见 eventReplySession.ts）。
      const eventReplyRequest = eventReplyPermissionRequest(tool, params, sessionId);
      if (eventReplyRequest) return eventReplyRequest;
      // Map permission level to permission request type
      const requestType = permissionRequestTypeForLevel(tool.permissionLevel);
      return {
        type: requestType,
        tool: tool.name,
        details: {
          ...params,
          ...(tool.name === 'terminal_write' && typeof params.input === 'string'
            ? { preview: buildTerminalApprovalPreview(params.input) }
            : {}),
        },
        reasonCode: PermissionRequestReason.Unknown,
        boundary: {
          id: boundaryIdForRequestType(requestType),
          reason: '根据工具权限级别推断的数据边界。',
        },
      };
    }
  }
}

/**
 * 写文件类操作的结构化原因码：仅当目标在工作区之外时归类为 FileWriteOutsideWorkspace，
 * 工作区内写入返回 undefined（boundary 文案已足够，避免误标“工作区外”）。
 */
export function fileWriteReasonCode(
  context: PermissionRequestBuilderContext,
  rawPath: unknown,
): PermissionRequestReason | undefined {
  return getFileBoundaryId(context, rawPath, true) === 'file.external_write'
    ? PermissionRequestReason.FileWriteOutsideWorkspace
    : undefined;
}

export function getFileBoundaryId(
  context: PermissionRequestBuilderContext,
  rawPath: unknown,
  isWrite: boolean,
): PermissionBoundaryId {
  const filePath = typeof rawPath === 'string' ? rawPath : '';
  if (!filePath) return isWrite ? 'file.project_write' : 'file.project_read';

  const workspace = context.runtimeWorkspace;
  const resolvedPath = nodePath.isAbsolute(filePath)
    ? nodePath.resolve(filePath)
    : nodePath.resolve(context.executionCwd, filePath);
  const match = context.runContext?.workspaceScope
    ? resolveWorkspacePath(context.runContext.workspaceScope, resolvedPath, isWrite ? 'read_write' : 'read')
    : undefined;
  const inWorkspace = context.runContext
    ? Boolean(match)
    : isRunPathInsideWorkspace(resolvedPath, workspace);

  if (inWorkspace) return isWrite ? 'file.project_write' : 'file.project_read';
  return isWrite ? 'file.external_write' : 'file.external_read';
}
