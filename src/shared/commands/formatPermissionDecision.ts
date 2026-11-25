import { humanizeInternalText, type InternalTextLanguage } from '../humanizeInternalText';
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

export function formatPermissionDecision(
  decision: PermissionDecisionLine,
  language: InternalTextLanguage,
  trace = '',
): string {
  const toolName = decision.toolName.trim();
  const label = decisionToolLabel(toolName, language);
  // Older decisions may have stored the canonical ID as the whole summary.
  const summary = decision.summary.toLowerCase().trim() === toolName.toLowerCase() ? '' : decision.summary.substring(0, 40);
  const subject = summary ? `${label}(${summary})` : label;
  return `${subject} → ${decision.outcome}  (${decision.reason}, ${decision.durationMs}ms${trace})`;
}
