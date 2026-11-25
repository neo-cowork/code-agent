import { humanizeInternalText, type InternalTextLanguage } from '../humanizeInternalText';
import { permissionDecisionLine } from '../i18n/permissionsCommand';
import { PERMISSION_DECISION_LABELS } from '../i18n/permissionDecisionLabels';
import { toolUserLabel } from '../utils/toolUserLabel';

interface PermissionDecisionLine {
  toolName: string;
  summary: string;
  outcome: string;
  reason: string;
  durationMs: number;
}

function decisionToolLabel(toolName: string, language: InternalTextLanguage): string {
  const labels = PERMISSION_DECISION_LABELS[language];
  switch (toolName.toLowerCase()) {
    case 'task':
    case 'spawn_agent':
    case 'agentspawn':
      return humanizeInternalText('spawn_agent', language).text;
    case 'mcpunified':
      return labels.externalTool;
    case 'process':
      return labels.backgroundJobs;
    default:
      return toolUserLabel(toolName, language);
  }
}

// 摘要里的家目录前缀换成 ~，截断不落在引号中间（不露出半截路径）。
function presentableSummary(raw: string, max = 40): string {
  const text = raw.replace(/(?:\/Users|\/home)\/[^/\s"']+/g, '~').replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '~');
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  for (const quote of ['"', "'"]) {
    if ((cut.match(new RegExp(quote, 'g')) ?? []).length % 2 === 1) cut = cut.slice(0, cut.lastIndexOf(quote));
  }
  return `${cut.trimEnd()}…`;
}

export function formatPermissionDecision(
  decision: PermissionDecisionLine,
  language: InternalTextLanguage,
  trace?: { finalOutcome: string; steps: number },
): string {
  const toolName = decision.toolName.trim();
  const label = decisionToolLabel(toolName, language);
  // Older decisions may have stored the canonical ID as the whole summary.
  const summary = decision.summary.toLowerCase().trim() === toolName.toLowerCase() ? '' : presentableSummary(decision.summary);
  const subject = summary ? `${label}(${summary})` : label;
  return permissionDecisionLine(language, subject, decision.outcome, decision.reason, decision.durationMs, trace);
}
