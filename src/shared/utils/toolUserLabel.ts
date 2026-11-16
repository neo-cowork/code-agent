// ============================================================================
// toolUserLabel —— 工具名 → 用户语义名（N-FIX-UI-RAW-TOOL-NAMES-EXPOSED）
//
// host 通知、停车收件箱等「不经 renderer i18n」的面向用户文案共用这一处，
// 不再把 Bash / mail_send 之类的内部工具名原样拼进标题或正文。
// 原始命令只放在审批卡的可展开详情里，通知只说动作。
// ============================================================================

import { PARKED_APPROVAL_ENTRY_PATH } from '../parkedApprovalLocation';
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
  docEdit: { zh: '编辑文档', en: 'Edit document' },
  excelGenerate: { zh: '导出表格', en: 'Export spreadsheet' },
  docxGenerate: { zh: '生成文档', en: 'Create document' },
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
  docedit: 'docEdit', excelgenerate: 'excelGenerate', docxgenerate: 'docxGenerate',
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

/** Approval copy for host banners; only localized actions, never commands or tool ids. */
export function permissionNotice(
  toolName: string | undefined,
  language: 'zh' | 'en',
  context: 'approval' | 'parked' | 'native' = 'approval',
): { title: string; body: string } {
  const en = language === 'en';
  // The native fallback also serves questions: preserve its generic wording.
  if (context === 'native') return {
    title: en ? 'Confirmation needed' : '有事项需要你确认',
    body: en ? 'A background task is waiting for your confirmation. Open Agent Neo to respond.' : '后台任务在等你确认，打开 Agent Neo 处理。',
  };
  const title = en ? 'Approval needed' : '需要授权';
  const label = toolName?.trim() ? toolUserLabel(toolName, language) : undefined;
  const body = label ? `${title}${en ? ': ' : '：'}${label}` : (en ? 'Review the proposed action.' : '请求执行权限');
  if (context !== 'parked') return { title, body };
  return { title, body: `${body}${en
    ? '. The task is paused. Open Agent Neo to review the unattended task.'
    : `。任务已暂停，到${PARKED_APPROVAL_ENTRY_PATH}处理。`}` };
}

/** Compatibility entry for callers needing only the approval body. */
export function permissionNoticeBody(toolName?: string, language: 'zh' | 'en' = 'zh'): string {
  return permissionNotice(toolName, language).body;
}
