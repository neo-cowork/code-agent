import type { Translations } from '../i18n';
import { findConnectorIdForToolName } from '@shared/contract/workbenchTools';
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

function normalizedLabelKey(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/[-_\s]/g, '');
}

function bareToolName(ownerLabel: string | undefined): string {
  return ownerLabel?.split('·').pop()?.trim() || '';
}

export function getHumanToolLabel(args: {
  connector?: string;
  toolName?: string;
  labels: HumanToolLabels;
}): string {
  const toolName = bareToolName(args.toolName);
  const connectorId = args.connector || findConnectorIdForToolName(toolName);
  const connectorKey = CONNECTOR_LABEL_KEYS[normalizedLabelKey(connectorId)];
  if (connectorKey) return args.labels.connectors[connectorKey];

  const toolKey = TOOL_LABEL_KEYS[normalizedLabelKey(toolName)];
  if (toolKey) return args.labels.tools[toolKey];

  return getToolDisplayName(toolName || args.labels.unknownTool);
}

// Background task details are not approval labels and may localize file actions.
export function getBackgroundTaskToolLabel(args: { toolName: string; labels: HumanToolLabels }): string {
  const key = normalizedLabelKey(args.toolName);
  if (key === 'write' || key === 'writefile') return args.labels.tools.writeFile;
  if (key === 'edit' || key === 'editfile') return args.labels.tools.editFile;
  return getHumanToolLabel(args);
}
