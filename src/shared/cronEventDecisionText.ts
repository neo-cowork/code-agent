// ============================================================================
// Cron event decision text
// ----------------------------------------------------------------------------
// The host persists the stable `stored` form. The renderer reverse-matches that
// same table so existing rows and newly written rows share localized UI copy.
// Text that does not match a host template is model-authored and passes through.
// ============================================================================

export type CronEventDecisionTextLanguage = 'zh' | 'en';

export type CronEventDecisionTextKey =
  | 'channelChatRule'
  | 'channelAnyChatRule'
  | 'mailRule'
  | 'webhookRule'
  | 'missingDecisions'
  | 'missingReason'
  | 'mismatchedDecisionIds'
  | 'queueOverflow'
  | 'carryLimit'
  | 'automationInactive'
  | 'modelAct'
  | 'modelIgnore'
  | 'runFailedWithCause'
  | 'runFailedWithoutCause'
  | 'observeIntercepted'
  | 'noOutboundAction'
  | 'runQuiet'
  | 'runReported';

type TextParams = Readonly<Record<string, string | number>>;

interface DecisionTextTemplate {
  key: CronEventDecisionTextKey;
  stored: string;
  zh: string;
  en: string;
  /** Parameters that are themselves another host-authored decision string. */
  nested?: readonly string[];
}

const TEMPLATES: readonly DecisionTextTemplate[] = [
  {
    key: 'channelChatRule',
    stored: 'channel message · account {account} · chat {chat}',
    zh: '通道消息 · 账号 {account} · 会话 {chat}',
    en: 'Channel message · account {account} · chat {chat}',
  },
  {
    key: 'channelAnyChatRule',
    stored: 'channel message · account {account} · any chat',
    zh: '通道消息 · 账号 {account} · 任意会话',
    en: 'Channel message · account {account} · any chat',
  },
  {
    key: 'mailRule',
    stored: 'mail message · account {account} · mailbox {mailbox}',
    zh: '邮件 · 账号 {account} · 收件箱 {mailbox}',
    en: 'Mail · account {account} · inbox {mailbox}',
  },
  {
    key: 'webhookRule',
    stored: 'webhook delivery · per-job hook URL',
    zh: 'Webhook 投递 · 此自动化的专用链接',
    en: 'Webhook delivery · this automation\'s dedicated link',
  },
  {
    key: 'missingDecisions',
    stored: 'run result carried no eventDecisions field',
    zh: '运行结果里没有逐事件判断',
    en: 'The run did not report a decision for each event',
  },
  {
    key: 'missingReason',
    stored: 'no per-event reason stated',
    zh: '模型没有说明每个事件的原因',
    en: 'The model gave no reason for this event',
  },
  {
    key: 'mismatchedDecisionIds',
    stored: 'stated decisions did not match this event id (stated ids: {ids})',
    zh: '模型给出的事件编号与这个事件不匹配',
    en: 'The model\'s event reference did not match this event',
  },
  {
    key: 'queueOverflow',
    stored: 'pending queue overflow (limit {limit}); oldest event dropped',
    zh: '待处理事件超过 {limit} 条，最早的一条已丢弃',
    en: 'More than {limit} events were waiting, so the oldest was dropped',
  },
  {
    key: 'carryLimit',
    stored: 'per-run carry limit ({limit} events) exceeded',
    zh: '单次运行最多处理 {limit} 个事件，超出的事件已丢弃',
    en: 'This run exceeded its {limit}-event limit, so the extra event was dropped',
  },
  {
    key: 'automationInactive',
    stored: 'automation was disabled or removed before the batch ran',
    zh: '这批事件运行前，自动化已停用或移除',
    en: 'The automation was disabled or removed before this batch ran',
  },
  { key: 'modelAct', stored: 'model chose to act', zh: '模型决定执行', en: 'The model chose to act' },
  { key: 'modelIgnore', stored: 'model chose to ignore', zh: '模型决定忽略', en: 'The model chose to ignore' },
  {
    key: 'observeIntercepted',
    stored: 'outbound action intercepted in observe mode ({why})',
    zh: '这个事件本会触发对外操作，但仅观察模式已拦下；{why}',
    en: 'This event would have triggered an outbound action, but observe mode stopped it; {why}',
    nested: ['why'],
  },
  {
    key: 'noOutboundAction',
    stored: 'no outbound action attempted ({why})',
    zh: '这个事件未触发任何对外操作；{why}',
    en: 'This event did not trigger any outbound action; {why}',
    nested: ['why'],
  },
  {
    key: 'runQuiet',
    stored: 'run stayed quiet (no alert; {why})',
    zh: '本次运行未发出提醒；{why}',
    en: 'The run stayed quiet and sent no alert; {why}',
    nested: ['why'],
  },
  {
    key: 'runReported',
    stored: 'run completed and reported ({why})',
    zh: '本次运行已完成并报告结果；{why}',
    en: 'The run completed and reported a result; {why}',
    nested: ['why'],
  },
  {
    key: 'runFailedWithCause',
    stored: 'run {status}: {cause}',
    zh: '运行未完成（{status}）：{cause}',
    en: 'Run {status}: {cause}',
  },
  {
    key: 'runFailedWithoutCause',
    stored: 'run {status}',
    zh: '运行未完成（{status}）',
    en: 'Run {status}',
  },
];

const BY_KEY = new Map(TEMPLATES.map((template) => [template.key, template]));
const PLACEHOLDER = /\{([a-z][a-zA-Z0-9]*)\}/g;

function render(template: string, params: TextParams): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => String(params[name] ?? ''));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matcherFor(template: string): { regex: RegExp; names: string[] } {
  const names: string[] = [];
  let pattern = '^';
  let cursor = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    pattern += escapeRegex(template.slice(cursor, match.index));
    pattern += '([\\s\\S]*?)';
    names.push(match[1]);
    cursor = (match.index ?? 0) + match[0].length;
  }
  pattern += `${escapeRegex(template.slice(cursor))}$`;
  return { regex: new RegExp(pattern), names };
}

const MATCHERS = TEMPLATES.map((template) => ({ template, ...matcherFor(template.stored) }));

/** Build the stable English text persisted by the host. */
export function buildCronEventDecisionText(key: CronEventDecisionTextKey, params: TextParams = {}): string {
  const template = BY_KEY.get(key);
  if (!template) return '';
  return render(template.stored, params);
}

function localizedStatus(status: string, language: CronEventDecisionTextLanguage): string {
  if (language === 'en') return status;
  const statuses: Readonly<Record<string, string>> = {
    pending: '等待中',
    running: '运行中',
    failed: '失败',
    cancelled: '已取消',
    paused: '已暂停',
    interrupted: '已中断',
    'failed to start': '未能启动',
  };
  return statuses[status] ?? status;
}

/** Localize a host-authored row; unmatched model-authored text is returned verbatim. */
export function localizeDecisionText(text: string, language: CronEventDecisionTextLanguage): string {
  for (const { template, regex, names } of MATCHERS) {
    const match = regex.exec(text);
    if (!match) continue;
    const params: Record<string, string> = {};
    names.forEach((name, index) => {
      const value = match[index + 1] ?? '';
      params[name] = template.nested?.includes(name)
        ? localizeDecisionText(value, language)
        : name === 'status' ? localizedStatus(value, language) : value;
    });
    return render(template[language], params);
  }
  return text;
}
