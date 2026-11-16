// ============================================================================
// toolUserLabel —— 工具名 → 用户语义名（N-FIX-UI-RAW-TOOL-NAMES-EXPOSED）
//
// host 通知、停车收件箱等「不经 renderer i18n」的面向用户文案共用这一处，
// 不再把 Bash / mail_send 之类的内部工具名原样拼进标题或正文。
// 原始命令只放在审批卡的可展开详情里，通知只说动作。
// ============================================================================

import { findConnectorToolMetadata, isMcpToolName } from '../contract/workbenchTools';

const TOOL_USER_LABELS: Record<string, string> = {
  bash: '运行命令',
  write: '写入文件',
  writefile: '写入文件',
  edit: '编辑文件',
  editfile: '编辑文件',
  read: '读取文件',
  readfile: '读取文件',
  glob: '查找文件',
  grep: '搜索内容',
  webfetch: '网页抓取',
  websearch: '联网搜索',
  memorysearch: '记忆检索',
  browseraction: '浏览器操作',
  computeruse: '电脑操作',
};

const TOOL_USER_LABELS_EN: Record<string, string> = {
  bash: 'Run command', write: 'Write file', writefile: 'Write file', edit: 'Edit file', editfile: 'Edit file',
  read: 'Read file', readfile: 'Read file', glob: 'Find files', grep: 'Search contents',
  webfetch: 'Web fetch', websearch: 'Web search', memorysearch: 'Memory search',
  browseraction: 'Browser action', computeruse: 'Computer action',
};

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
  const key = name.toLowerCase().replace(/[-_\s]/g, '');
  return (en ? TOOL_USER_LABELS_EN[key] : TOOL_USER_LABELS[key]) ?? (en ? 'Action' : UNKNOWN_LABEL);
}

/** 「需要授权」类通知正文：只说动作，不带原始命令 / 工具名。 */
export function permissionNoticeBody(toolName?: string): string {
  const name = (toolName ?? '').trim();
  return name ? `需要授权：${toolUserLabel(name)}` : '请求执行权限';
}
