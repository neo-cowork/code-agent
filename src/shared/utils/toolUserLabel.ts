// ============================================================================
// toolUserLabel —— 工具名 → 用户语义名（N-FIX-UI-RAW-TOOL-NAMES-EXPOSED）
//
// host 通知、停车收件箱等「不经 renderer i18n」的面向用户文案共用这一处，
// 不再把 Bash / mail_send 之类的内部工具名原样拼进标题或正文。
// 原始命令只放在审批卡的可展开详情里，通知只说动作。
// ============================================================================

import { findConnectorToolMetadata, isMcpToolName } from '../contract/workbenchTools';

// Action ids also serve as renderer translation keys. Aliases contain no translated copy.
const TOOL_ACTION_LABELS = {
  runCommand: { zh: '运行命令', en: 'Run command' },
  writeFile: { zh: '写入文件', en: 'Write file' },
  editFile: { zh: '编辑文件', en: 'Edit file' },
  readFile: { zh: '读取文件', en: 'Read file' },
  findFiles: { zh: '查找文件', en: 'Find files' },
  searchContents: { zh: '搜索内容', en: 'Search contents' },
  webFetch: { zh: '网页抓取', en: 'Web fetch' },
  webSearch: { zh: '联网搜索', en: 'Web search' },
  memorySearch: { zh: '记忆检索', en: 'Memory search' },
  browserAction: { zh: '浏览器操作', en: 'Browser action' },
  computerUse: { zh: '电脑操作', en: 'Computer action' },
};

type ToolActionId = keyof typeof TOOL_ACTION_LABELS;

const TOOL_ACTION_ALIASES: Readonly<Record<string, ToolActionId>> = {
  bash: 'runCommand', runcommand: 'runCommand',
  write: 'writeFile', writefile: 'writeFile',
  edit: 'editFile', editfile: 'editFile',
  read: 'readFile', readfile: 'readFile',
  glob: 'findFiles', findfiles: 'findFiles',
  grep: 'searchContents', searchcontents: 'searchContents',
  webfetch: 'webFetch', websearch: 'webSearch', memorysearch: 'memorySearch',
  browseraction: 'browserAction', computeruse: 'computerUse',
};

/** Resolve only registered action names; consumers retain their own unknown-tool fallback. */
export function getToolActionId(toolName: string): ToolActionId | undefined {
  const key = toolName.trim().toLowerCase().replace(/[-_\s]/g, '');
  return Object.hasOwn(TOOL_ACTION_ALIASES, key) ? TOOL_ACTION_ALIASES[key] : undefined;
}

/** Renderer translation tree and host notifications share the same bilingual action table. */
export function getToolActionLabels(language: 'zh' | 'en'): Record<ToolActionId, string> {
  return Object.fromEntries(Object.entries(TOOL_ACTION_LABELS).map(([id, copy]) => [id, copy[language]])) as Record<ToolActionId, string>;
}

const UNKNOWN_LABEL = '操作';

/** 用户看得懂的动作名；连接器工具返回连接器名（邮件/日历…），未知工具返回「操作」而不是原名。 */
export function toolUserLabel(toolName?: string, language: 'zh' | 'en' = 'zh'): string {
  const en = language === 'en';
  const name = (toolName ?? '').trim();
  if (!name) return en ? 'Action' : UNKNOWN_LABEL;
  if (/[\u4e00-\u9fff]/.test(name)) return name; // 已经是中文展示名
  const connector = findConnectorToolMetadata(name);
  if (connector) {
    if (en) return connector.action?.en ? `${connector.connectorNameEn}: ${connector.action.en}` : connector.connectorNameEn;
    return connector.action?.zh ? `${connector.connectorName}：${connector.action.zh}` : connector.connectorName;
  }
  if (isMcpToolName(name)) return en ? 'External tool' : '外部工具';
  const action = getToolActionId(name);
  return action ? TOOL_ACTION_LABELS[action][language] : (en ? 'Action' : UNKNOWN_LABEL);
}

/** 「需要授权」类通知正文：只说动作，不带原始命令 / 工具名。 */
export function permissionNoticeBody(toolName?: string): string {
  const name = (toolName ?? '').trim();
  return name ? `需要授权：${toolUserLabel(name)}` : '请求执行权限';
}
