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
    default: '每次先问我', readOnly: '只读', acceptEdits: '替我审批', bypassPermissions: '完全访问权限',
    dontAsk: '不再询问', plan: '计划', delegate: '委派',
  },
  en: {
    default: 'Ask every time', readOnly: 'Read only', acceptEdits: 'Approve for me', bypassPermissions: 'Full access',
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

// toolExecutor / toolExecutorDecisionTrace 的 recordDecision 实际写入的 reason 码；未登记的不原样露出。
const reasonLabels = {
  zh: {
    'safe-command': '安全命令', 'pre-approved': '已预先批准', 'user-permission-rule': '你设置的权限规则',
    'exec-policy': '命令规则', 'readonly-probe-plan': '只读探查', 'approved-rm-verify-probe': '已批准的删除核对',
    'lenient-mode': '宽松模式', 'directive-memory-headless-skip-permissions': '后台记忆写入',
    'cua-app-target-unresolved': '无法确定要操作的应用', 'command_analysis_sticky': '此前已拦截的命令',
    'peermsg-launder': '来自其他助手的消息', 'peer-origin-unattended': '无人值守的外部来源',
    'permission_path_analysis_failed': '路径无法分析', 'user-denied-sticky': '此前已被你拒绝',
    'no-approval-ui': '没有可用的审批界面', security: '安全检查', policy: '策略限制', classifier: '安全检查',
    'path policy': '路径限制', user: '你', unspecified: '已批准',
    'run tool policy (--tools/--disallowed-tools)': '运行时工具限制',
  },
  en: {
    'safe-command': 'safe command', 'pre-approved': 'pre-approved', 'user-permission-rule': 'your permission rule',
    'exec-policy': 'command rule', 'readonly-probe-plan': 'read-only probe', 'approved-rm-verify-probe': 'approved delete check',
    'lenient-mode': 'lenient mode', 'directive-memory-headless-skip-permissions': 'background memory write',
    'cua-app-target-unresolved': 'target app not identified', 'command_analysis_sticky': 'previously blocked command',
    'peermsg-launder': 'message from another assistant', 'peer-origin-unattended': 'unattended outside source',
    'permission_path_analysis_failed': 'path could not be analyzed', 'user-denied-sticky': 'previously denied by you',
    'no-approval-ui': 'no approval screen available', security: 'safety check', policy: 'policy limit', classifier: 'safety check',
    'path policy': 'path limit', user: 'you', unspecified: 'approved',
    'run tool policy (--tools/--disallowed-tools)': 'run-time tool limit',
  },
} as const satisfies Record<Language, Record<string, string>>;

// 检查轨迹的 finalOutcome 在 host 里既有 allow/deny，也有历史结果 id。
const traceVerdictLabels = {
  zh: { allow: '放行', deny: '拒绝' },
  en: { allow: 'allowed', deny: 'denied' },
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

function permissionTraceLabel(language: Language, finalOutcome: string): string {
  const verdicts: Record<string, string> = traceVerdictLabels[language];
  return has(verdicts, finalOutcome) ? verdicts[finalOutcome] : permissionOutcomeLabel(language, finalOutcome);
}

function permissionReasonLabel(language: Language, reason: string): string {
  const table: Record<string, string> = reasonLabels[language];
  if (has(table, reason)) return table[reason];
  const generic = language === 'zh' ? '按系统规则' : 'system rule';
  const looksLikeId = /^[a-z0-9_:.-]+$/i.test(reason);
  if (language === 'zh') return /[A-Za-z]{2,}/.test(reason) ? generic : reason;
  return looksLikeId || /[\u4e00-\u9fff]/.test(reason) ? generic : reason;
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
  const traceText = trace ? m.trace(permissionTraceLabel(language, trace.finalOutcome), trace.steps) : '';
  return m.decision(subject, permissionOutcomeLabel(language, outcome), permissionReasonLabel(language, reason), durationMs, traceText);
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
