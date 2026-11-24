// ============================================================================
// toolUserLabel —— 工具名 → 用户语义名（N-FIX-UI-RAW-TOOL-NAMES-EXPOSED）
//
// host 通知、停车收件箱等「不经 renderer i18n」的面向用户文案共用这一处，
// 不再把 Bash / mail_send 之类的内部工具名原样拼进标题或正文。
// 原始命令只放在审批卡的可展开详情里，通知只说动作。
// ============================================================================

import { APPROVAL_NOTIFICATION_TEXT } from '../i18n/approvalNotification';
import { WAITING_ON_USER_LABELS } from '../i18n/waitingOnUserLabels';
import { findConnectorToolMetadata, isMcpToolName } from '../contract/workbenchTools';
import { catalogConnectorToolPhrase } from './catalogConnectorToolLabel';

const TOOL_USER_LABELS: Record<string, string> = {
  bash: '运行命令',
  write: '写入文件',
  writefile: '写入文件',
  edit: '编辑文件',
  editfile: '编辑文件',
  docedit: '编辑文档',
  excelgenerate: '导出表格',
  docxgenerate: '生成文档',
  read: '读取文件',
  readfile: '读取文件',
  glob: '查找文件',
  grep: '搜索内容',
  webfetch: '网页抓取',
  websearch: '联网搜索',
  httprequest: '网络请求',
  memorysearch: '记忆检索',
  libraryadd: '放入资料库',
  browseraction: '浏览器操作',
  computeruse: '电脑操作',
};

const TOOL_USER_LABELS_EN: Record<string, string> = {
  bash: 'Run command', write: 'Write file', writefile: 'Write file', edit: 'Edit file', editfile: 'Edit file',
  docedit: 'Edit document', excelgenerate: 'Export spreadsheet', docxgenerate: 'Create document',
  read: 'Read file', readfile: 'Read file', glob: 'Find files', grep: 'Search contents',
  webfetch: 'Web fetch', websearch: 'Web search', memorysearch: 'Memory search', libraryadd: 'Add to Library',
  httprequest: 'Network request',
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
  const catalog = catalogConnectorToolPhrase(name, language);
  if (catalog) return catalog;
  if (isMcpToolName(name)) return en ? 'External tool' : '外部工具';
  const key = name.toLowerCase().replace(/[-_\s]/g, '');
  const labels = en ? TOOL_USER_LABELS_EN : TOOL_USER_LABELS;
  return Object.hasOwn(labels, key) ? labels[key] : (en ? 'Action' : UNKNOWN_LABEL);
}

/** Approval copy for host banners; only localized actions, never commands or tool ids. */
export function permissionNotice(
  toolName: string | undefined,
  language: 'zh' | 'en',
  context: 'approval' | 'parked' | 'first_wake' = 'approval',
  sessionTitle?: string,
): { title: string; body: string } {
  const copy = APPROVAL_NOTIFICATION_TEXT[language];
  const title = sessionTitle ? copy.namedTitle(sessionTitle) : copy.title;
  const body = toolName?.trim()
    ? WAITING_ON_USER_LABELS[language].approvalWithLabel.replace('{label}', () => toolUserLabel(toolName, language))
    : copy.noTool;
  return { title, body: body + copy[context] };
}
