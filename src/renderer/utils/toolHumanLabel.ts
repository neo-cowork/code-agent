import type { Translations } from '../i18n';
import { findConnectorIdForToolName, findConnectorToolMetadata } from '@shared/contract/workbenchTools';
import { getKnownMcpServerName, isComputerUseMcpServer, parseMcpToolName } from './mcpServerLabel';
import { getToolDisplayName } from '../components/features/chat/MessageBubble/ToolCallDisplay/utils';

type HumanToolLabels = Translations['receiptPresentation']['humanToolLabels'];

const CONNECTOR_LABEL_KEYS: Record<string, keyof HumanToolLabels['connectors']> = {
  mail: 'mail',
  calendar: 'calendar',
  reminders: 'reminders',
  tmeet: 'tmeet',
  feishu: 'feishu',
};

const TOOL_LABEL_KEYS: Record<string, keyof HumanToolLabels['tools']> = {
  webfetch: 'webFetch',
  websearch: 'webSearch',
  read: 'readFile',
  glob: 'findFiles',
  grep: 'findFiles',
  readfile: 'readFile',
  memorysearch: 'memorySearch',
};

// 只登记「纯读取」的工具；混有变更动作的工具（如 SessionManager 的 create/archive/rename）不得登记，免得变更卡写成「读取…」。
const READ_OBJECT_KEYS: Record<string, keyof HumanToolLabels['readObjects']> = {
  meetingrecords: 'meetingRecords',
  readclipboard: 'clipboard',
  memoryread: 'memory',
  episodicrecall: 'pastConversations',
  history: 'pastConversations',
};

function normalizedLabelKey(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/[-_\s]/g, '');
}

function bareToolName(ownerLabel: string | undefined): string {
  return ownerLabel?.split('·').pop()?.trim() || '';
}

/** 只读审批卡「读取{对象}」的对象名：只认连接器名与只读对象名词，没有登记就返回 undefined（不回落原名）。 */
export function resolveReadObjectLabel(args: { toolName?: string; labels: HumanToolLabels }): string | undefined {
  const toolName = bareToolName(args.toolName);
  // 写类连接器工具（mail_send / reminders_create …）不是「读取」，不借连接器名。
  if (findConnectorToolMetadata(toolName)?.action) return undefined;
  const connectorKey = CONNECTOR_LABEL_KEYS[normalizedLabelKey(findConnectorIdForToolName(toolName))];
  if (connectorKey) return args.labels.connectors[connectorKey];
  const objectKey = READ_OBJECT_KEYS[normalizedLabelKey(toolName)];
  return objectKey ? args.labels.readObjects[objectKey] : undefined;
}

export function getHumanToolLabel(args: {
  connector?: string;
  toolName?: string;
  labels: HumanToolLabels;
  fallback?: () => string;
}): string {
  const toolName = bareToolName(args.toolName);
  const connectorId = args.connector || findConnectorIdForToolName(toolName);
  const connector = normalizedLabelKey(connectorId);
  if (Object.hasOwn(CONNECTOR_LABEL_KEYS, connector)) return args.labels.connectors[CONNECTOR_LABEL_KEYS[connector]];

  // mcp__server__tool / mcp_server_tool：cua-driver 走 Computer Use 人话，
  // 解不动的 mcp__ 名给中性词，都不漏原文（FB-2291）；已登记的 server 保留展示名。
  if (toolName.startsWith('mcp_')) {
    const parsed = parseMcpToolName(toolName);
    if (!parsed) return args.labels.unknownTool;
    if (isComputerUseMcpServer(parsed.server)) return args.labels.tools.computerUse;
    const serverName = getKnownMcpServerName(parsed.server);
    if (serverName) return serverName;
  }

  const name = normalizedLabelKey(toolName);
  if (Object.hasOwn(TOOL_LABEL_KEYS, name)) return args.labels.tools[TOOL_LABEL_KEYS[name]];

  if (Object.hasOwn(READ_OBJECT_KEYS, name)) return args.labels.readObjects[READ_OBJECT_KEYS[name]];

  return args.fallback?.() ?? getToolDisplayName(toolName || args.labels.unknownTool);
}

// Background task details are not approval labels and may localize file actions.
export function getBackgroundTaskToolLabel(args: { toolName: string; labels: HumanToolLabels }): string {
  const key = normalizedLabelKey(args.toolName);
  if (key === 'write' || key === 'writefile') return args.labels.tools.writeFile;
  if (key === 'edit' || key === 'editfile') return args.labels.tools.editFile;
  return getHumanToolLabel(args);
}
