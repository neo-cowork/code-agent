// ============================================================================
// toolProgressLabel —— 工具名 → 现在进行时的一句人话（N-FIX-PROGRESS-STEP-RAW-TOOL-NAME）
//
// 进度行 / 任务栏在没有更好文案时用它兜底：永远不输出原始工具 id，
// 也不输出 tool_running 这类内部阶段词。host（toolBatchLabel）与 renderer 共用。
// ============================================================================

import { findConnectorToolMetadata, isMcpToolName } from '../contract/workbenchTools';
import { catalogConnectorToolPhrase } from './catalogConnectorToolLabel';
import { toolUserLabel } from './toolUserLabel';

type Locale = 'zh' | 'en';

const WORKING_ZH = '正在执行操作';
const WORKING_EN = 'Working on it';

// 连接器写动作（en 为不定式短语，如 "create an event"）→ 进行时首词
const EN_GERUNDS: Record<string, string> = {
  send: 'Sending', save: 'Saving', create: 'Creating', update: 'Updating', delete: 'Deleting',
};

// toolUserLabel 的 en 标签 → 进行时短语（与该表一一对应）
const EN_PROGRESS_BY_LABEL: Record<string, string> = {
  'Run command': 'Running a command',
  'Write file': 'Writing a file',
  'Edit file': 'Editing a file',
  'Edit document': 'Editing a document',
  'Export spreadsheet': 'Exporting a spreadsheet',
  'Create document': 'Creating a document',
  'Read file': 'Reading a file',
  'Find files': 'Finding files',
  'Search contents': 'Searching contents',
  'Web fetch': 'Fetching a web page',
  'Web search': 'Searching the web',
  'Memory search': 'Searching memory',
  'Add to Library': 'Adding to Library',
  'Browser action': 'Using the browser',
  'Computer action': 'Using the computer',
};

export function toolProgressLabel(toolName: string | undefined, locale: Locale): string {
  const en = locale === 'en';
  const fallback = en ? WORKING_EN : WORKING_ZH;
  const name = (toolName ?? '').trim();
  if (!name) return fallback;

  const connector = findConnectorToolMetadata(name);
  if (connector) {
    if (!connector.action) return en ? `Checking ${connector.connectorNameEn}` : `正在查看${connector.connectorName}`;
    if (!en) return `正在${connector.action.zh}`;
    const [verb, ...rest] = connector.action.en.split(' ');
    const gerund = EN_GERUNDS[verb];
    return gerund ? [gerund, ...rest].join(' ') : fallback;
  }

  const catalog = catalogConnectorToolPhrase(name, locale, 'progressive');
  if (catalog) return catalog;
  if (isMcpToolName(name)) return en ? 'Using an external tool' : '正在使用外部工具';

  const label = toolUserLabel(name, locale);
  if (en) return EN_PROGRESS_BY_LABEL[label] ?? fallback;
  return label === '操作' ? fallback : `正在${label}`;
}
