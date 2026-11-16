// ============================================================================
// catalogConnectorToolLabel —— 目录连接器（飞书等 mcp__<id>__<tool>）的用户语义名
//
// 通知 / 停车收件箱 / 状态栏 / 审批卡预览共用这一处：只出现目录里的连接器名
// 与人话动作，不出现 mcp__ 前缀、连接器 id、英文参数名。
// 动作 = 工具名末段动词 + 名词小表；认不出来就退到「写入/读取 + 连接器名」，绝不回落原名。
// ============================================================================

import { RECOMMENDED_MCP_SERVERS } from '../constants/mcpCatalog';

type Language = 'zh' | 'en';
export type CatalogToolTense = 'imperative' | 'progressive' | 'past';

interface Verb { access: 'read' | 'write'; zh: string; en: [string, string, string] }
const VERBS: Record<string, Verb> = {
  create: { access: 'write', zh: '创建', en: ['Create', 'Creating', 'Created'] },
  update: { access: 'write', zh: '修改', en: ['Update', 'Updating', 'Updated'] },
  patch: { access: 'write', zh: '修改', en: ['Update', 'Updating', 'Updated'] },
  delete: { access: 'write', zh: '删除', en: ['Delete', 'Deleting', 'Deleted'] },
  send: { access: 'write', zh: '发送', en: ['Send', 'Sending', 'Sent'] },
  reply: { access: 'write', zh: '回复', en: ['Reply to', 'Replying to', 'Replied to'] },
  list: { access: 'read', zh: '查看', en: ['View', 'Viewing', 'Viewed'] },
  get: { access: 'read', zh: '查看', en: ['View', 'Viewing', 'Viewed'] },
  search: { access: 'read', zh: '查找', en: ['Search', 'Searching', 'Searched'] },
};

// 只收实际见过的工具（飞书日历 / 消息 / 多维表格）；新连接器的新名词在这里补一行。
const NOUNS: Record<string, { zh: string; one: string; many: string }> = {
  calendarEvent: { zh: '日程', one: 'an event', many: 'events' },
  message: { zh: '消息', one: 'a message', many: 'messages' },
  appTableRecord: { zh: '表格记录', one: 'a table record', many: 'table records' },
};

// 已知写类工具的参数名 → 用户语言。不认识的参数只显示值，不露英文键（N-APPROVAL-CARD…-NAMES 取舍）。
const PARAM_LABELS: Record<string, { zh: string; en: string }> = {
  start_time: { zh: '开始时间', en: 'Start time' },
  end_time: { zh: '结束时间', en: 'End time' },
  summary: { zh: '标题', en: 'Title' },
  title: { zh: '标题', en: 'Title' },
  description: { zh: '描述', en: 'Description' },
  attendees: { zh: '参与人', en: 'Attendees' },
  location: { zh: '地点', en: 'Location' },
  content: { zh: '内容', en: 'Content' },
  text: { zh: '内容', en: 'Content' },
};

// 与 host classifyConnectorTool 同源：只认目录里声明了 readOnlyTools 的连接器。
const CONNECTORS = new Map(RECOMMENDED_MCP_SERVERS
  .filter((entry) => entry.readOnlyTools !== undefined)
  .map((entry) => [entry.id, entry]));

export interface CatalogConnectorTool {
  connectorId: string;
  name: string;
  nameEn: string;
  access: 'read' | 'write';
  verb?: Verb;
  noun?: { zh: string; one: string; many: string };
}

export function resolveCatalogConnectorTool(toolName: string | undefined): CatalogConnectorTool | undefined {
  const parsed = /^mcp__(.+?)__(.+)$/.exec(toolName ?? '');
  const entry = parsed ? CONNECTORS.get(parsed[1]) : undefined;
  if (!parsed || !entry) return undefined;
  const bare = parsed[2].replace(/\./g, '_');
  const canonical = (entry.readOnlyTools ?? []).some((tool) => tool.replace(/\./g, '_') === bare);
  const tokens = bare.split('_');
  const verb = VERBS[tokens[tokens.length - 1].toLowerCase()];
  const noun = tokens.length > 1 ? NOUNS[tokens[tokens.length - 2]] : undefined;
  return {
    connectorId: entry.id,
    name: entry.name,
    nameEn: entry.displayNameEn ?? entry.name,
    access: canonical ? 'read' : 'write',
    ...(verb ? { verb } : {}),
    ...(noun ? { noun } : {}),
  };
}

/** 「在飞书创建日程」/「Create an event in Feishu」；认不出动作时「写入飞书」/「Write to Feishu」。 */
export function catalogConnectorToolPhrase(
  toolName: string | undefined,
  language: Language = 'zh',
  tense: CatalogToolTense = 'imperative',
): string | undefined {
  const tool = resolveCatalogConnectorTool(toolName);
  if (!tool) return undefined;
  const en = language === 'en';
  const name = en ? tool.nameEn : tool.name;
  const write = (tool.verb?.access ?? tool.access) === 'write';
  if (!tool.verb || !tool.noun) {
    if (en) {
      const forms = write ? ['Write to', 'Writing to', 'Wrote to'] : ['Read from', 'Reading from', 'Read from'];
      return `${forms[tense === 'imperative' ? 0 : tense === 'progressive' ? 1 : 2]} ${name}`;
    }
    const base = `${write ? '写入' : '读取'}${name}`;
    return tense === 'progressive' ? `正在${base}` : tense === 'past' ? `已${base}` : base;
  }
  if (en) {
    const verb = tool.verb.en[tense === 'imperative' ? 0 : tense === 'progressive' ? 1 : 2];
    return `${verb} ${tool.verb.access === 'read' ? tool.noun.many : tool.noun.one} in ${name}`;
  }
  const base = `在${name}${tool.verb.zh}${tool.noun.zh}`;
  return tense === 'progressive' ? `正在${base.slice(1)}` : tense === 'past' ? `已${base}` : base;
}

/** 审批卡预览的「参数名: 值」逐行 → [label | null, value]；认识的键给本地化标签，不认识的只留值。 */
export function catalogConnectorParamRows(
  diff: string | undefined,
  language: Language = 'zh',
): Array<{ label: string | null; value: string }> {
  const rows: Array<{ label: string | null; value: string }> = [];
  for (const line of (diff ?? '').split('\n')) {
    const at = line.indexOf(':');
    if (at < 0) {
      if (line.trim()) rows.push({ label: null, value: line.trim() });
      continue;
    }
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!value) continue;
    const known = PARAM_LABELS[key];
    rows.push({ label: known ? known[language] : null, value });
  }
  return rows;
}

/** 目录连接器 id → 界面语言下的显示名；目录里没有则返回 fallback。 */
export function catalogConnectorDisplayName(connectorId: string, language: Language, fallback: string): string {
  const entry = CONNECTORS.get(connectorId);
  return entry ? (language === 'en' ? entry.displayNameEn ?? entry.name : entry.name) : fallback;
}
