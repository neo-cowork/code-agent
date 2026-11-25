// /permissions 诊断块的双语文案与排版：CLI（newCommands.ts）与 GUI（SlashCommandPopover）共用，
// 两处不再各写一份英文字面量。档位词与 renderer/i18n/permissionVocabulary.ts 保持同步（有测试钉住）。
type Language = 'zh' | 'en';

const messages = {
  zh: {
    title: '权限',
    mode: (label: string) => `  当前档位：${label}`,
    execPolicy: (n: number) => `  执行规则（${n} 条）：`,
    noRules: '    暂无已学习的规则',
    moreRules: (n: number) => `    ……另有 ${n} 条`,
    execPolicyUnavailable: '  执行规则：暂不可用',
    recent: (total: number, shown: number) => `  最近决定（共 ${total} 条，显示最近 ${shown} 条）：`,
    noDecisions: '    暂无决定',
    recentUnavailable: '  最近决定：暂不可用',
    decision: (subject: string, outcome: string, reason: string, ms: number, trace: string) =>
      `${subject} → ${outcome}  （${reason}，${ms} 毫秒${trace}）`,
    trace: (outcome: string, steps: number) => `，检查轨迹 ${outcome}/${steps}`,
    ruleSource: (source: 'user' | 'builtin', time: string) => (source === 'builtin' ? '内置' : time),
    unknownOutcome: '已处理',
    unknownMode: '未知',
    justNow: '刚刚',
    minutesAgo: (n: number) => `${n} 分钟前`,
    hoursAgo: (n: number) => `${n} 小时前`,
    daysAgo: (n: number) => `${n} 天前`,
  },
  en: {
    title: 'Permissions',
    mode: (label: string) => `  Mode: ${label}`,
    execPolicy: (n: number) => `  Command rules (${n}):`,
    noRules: '    (no rules learned yet)',
    moreRules: (n: number) => `    ... and ${n} more`,
    execPolicyUnavailable: '  Command rules: (not available)',
    recent: (total: number, shown: number) => `  Recent decisions (${total} total, showing last ${shown}):`,
    noDecisions: '    (no decisions yet)',
    recentUnavailable: '  Recent decisions: (not available)',
    decision: (subject: string, outcome: string, reason: string, ms: number, trace: string) =>
      `${subject} → ${outcome}  (${reason}, ${ms} ms${trace})`,
    trace: (outcome: string, steps: number) => `, checks ${outcome}/${steps}`,
    ruleSource: (source: 'user' | 'builtin', time: string) => (source === 'builtin' ? 'built-in' : time),
    unknownOutcome: 'Handled',
    unknownMode: 'Unknown',
    justNow: 'just now',
    minutesAgo: (n: number) => `${n}m ago`,
    hoursAgo: (n: number) => `${n}h ago`,
    daysAgo: (n: number) => `${n}d ago`,
  },
} as const;

const modeLabels = {
  zh: {
    default: '请求批准', readOnly: '只读', acceptEdits: '替我审批', bypassPermissions: '完全访问权限',
    dontAsk: '不再询问', plan: '计划', delegate: '委派',
  },
  en: {
    default: 'Request approval', readOnly: 'Read only', acceptEdits: 'Approve for me', bypassPermissions: 'Full access',
    dontAsk: "Don't ask", plan: 'Plan', delegate: 'Delegate',
  },
} as const satisfies Record<Language, Record<string, string>>;

const outcomeLabels = {
  zh: {
    'auto-approve': '自动放行', 'ask-approved': '已批准', 'ask-denied': '已拒绝', 'policy-allow': '规则放行',
    'policy-deny': '规则拒绝', 'classifier-deny': '安全检查拦截', 'hook-blocked': '钩子拦截', 'monitor-blocked': '监控拦截',
  },
  en: {
    'auto-approve': 'Auto-approved', 'ask-approved': 'Approved', 'ask-denied': 'Denied', 'policy-allow': 'Allowed by rule',
    'policy-deny': 'Denied by rule', 'classifier-deny': 'Blocked by safety check', 'hook-blocked': 'Blocked by hook',
    'monitor-blocked': 'Blocked by monitor',
  },
} as const satisfies Record<Language, Record<string, string>>;

const ruleDecisionLabels = {
  zh: { allow: '允许', prompt: '询问', forbidden: '禁止' },
  en: { allow: 'allow', prompt: 'ask', forbidden: 'forbid' },
} as const satisfies Record<Language, Record<string, string>>;

const has = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

function permissionModeLabel(language: Language, mode: string): string {
  const table: Record<string, string> = modeLabels[language];
  return has(table, mode) ? table[mode] : messages[language].unknownMode;
}

function permissionOutcomeLabel(language: Language, outcome: string): string {
  const table: Record<string, string> = outcomeLabels[language];
  return has(table, outcome) ? table[outcome] : messages[language].unknownOutcome;
}

export function permissionDecisionLine(
  language: Language,
  subject: string,
  outcome: string,
  reason: string,
  durationMs: number,
  trace?: { finalOutcome: string; steps: number },
): string {
  const m = messages[language];
  const traceText = trace ? m.trace(permissionOutcomeLabel(language, trace.finalOutcome), trace.steps) : '';
  return m.decision(subject, permissionOutcomeLabel(language, outcome), reason, durationMs, traceText);
}

function relativeTime(language: Language, ts: number, now: number): string {
  const m = messages[language];
  const diff = now - ts;
  if (diff < 60_000) return m.justNow;
  if (diff < 3_600_000) return m.minutesAgo(Math.floor(diff / 60_000));
  if (diff < 86_400_000) return m.hoursAgo(Math.floor(diff / 3_600_000));
  return m.daysAgo(Math.floor(diff / 86_400_000));
}

export interface PermissionsBlockData {
  mode: string;
  /** null = 读取失败 */
  rules: Array<{ pattern: string[]; decision: string; source: string; createdAt?: number }> | null;
  /** null = 读取失败；lines 已由调用方用 formatPermissionDecision 排好版 */
  decisions: { total: number; lines: string[] } | null;
  now?: number;
}

export function formatPermissionsBlock(language: Language, data: PermissionsBlockData): string[] {
  const m = messages[language];
  const out: string[] = [m.title, m.mode(permissionModeLabel(language, data.mode)), ''];
  if (!data.rules) {
    out.push(m.execPolicyUnavailable);
  } else {
    out.push(m.execPolicy(data.rules.length));
    if (data.rules.length === 0) {
      out.push(m.noRules);
    } else {
      const decisionTable: Record<string, string> = ruleDecisionLabels[language];
      for (const rule of data.rules.slice(0, 15)) {
        const time = rule.createdAt === undefined ? '' : relativeTime(language, rule.createdAt, data.now ?? Date.now());
        const source = m.ruleSource(rule.source === 'builtin' ? 'builtin' : 'user', time);
        const decision = has(decisionTable, rule.decision) ? decisionTable[rule.decision] : rule.decision;
        out.push(`    ${(rule.pattern.join(' ') + ' *').padEnd(24)} → ${decision}  (${source})`);
      }
      if (data.rules.length > 15) out.push(m.moreRules(data.rules.length - 15));
    }
  }
  out.push('');
  if (!data.decisions) {
    out.push(m.recentUnavailable);
  } else {
    out.push(m.recent(data.decisions.total, data.decisions.lines.length));
    if (data.decisions.lines.length === 0) out.push(m.noDecisions);
    else for (const line of data.decisions.lines) out.push(`    ${line}`);
  }
  return out;
}
