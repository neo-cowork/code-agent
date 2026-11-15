import { ROLE_ASSETS, ROLE_PROACTIVITY } from "@shared/constants";

type WakeLabels = Record<'cadence' | 'event' | 'fallback', string>;
type DecisionLabels = Record<'advance' | 'report' | 'suggest', string>;

/** Only the summary prefix is a status; quoted tags elsewhere remain user text. */
export function formatRoleHistoryLine(line: string, labels: DecisionLabels, wakeLabels?: WakeLabels): string {
  if (wakeLabels) {
    const history = line.match(/^((?:- )?\d{4}-\d{2}-\d{2})(?: \| (.*?) \| | )([\s\S]*)$/);
    if (history) {
      const [, date, label, summary] = history;
      const prefix = label === undefined ? `${date} ` : `${date} | ${formatWakeSummary(label, wakeLabels)} | `;
      line = prefix + formatWakeSummary(summary, wakeLabels);
    } else {
      line = line.split('\n').map((part) => formatWakeSummary(part, wakeLabels)).join('\n');
    }
  }
  return line.replace(
    /^((?:- )?\d{4}-\d{2}-\d{2}(?: \| .*? \| | )|)[ \t]*\[(advance|report|suggest)\](?=\s|$)/gm,
    (_match, prefix: string, decision: keyof DecisionLabels) => `${prefix}${labels[decision]}`,
  );
}

function formatWakeSummary(value: string, labels: WakeLabels): string {
  const decision = value.match(/^\[(advance|report|suggest)\]\s*/)?.[0] ?? '';
  const summary = value.slice(decision.length);
  if (summary.match(ROLE_ASSETS.WAKE_TASK_PROMPT_PATTERN)?.index === 0 || summary === ROLE_ASSETS.WAKE_HISTORY_FALLBACK_SUMMARY) {
    return decision + labels.fallback;
  }
  for (const trigger of ['cadence', 'event'] as const) {
    const stored = `${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}（${trigger} 触发）`;
    if (summary.startsWith(stored)) return decision + labels[trigger] + summary.slice(stored.length);
  }
  return value;
}
