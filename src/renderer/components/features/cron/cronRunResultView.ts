import type { CronUrgency } from '@shared/contract/sessionAutomation';
import { splitCronRunMessage } from '@shared/cronRunMessage';
import { declaresCronUrgencyQuiet, isCronUrgency, parseUrgencyHeader } from '@shared/cronUrgency';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readableText(source: string): string {
  return splitCronRunMessage(source).map((segment) => (
    segment.text
      .split(/\r?\n/)
      .filter((line) => !/^\s*urgency\s*:/i.test(line) && !/^\s*artifact:\s*/i.test(line))
      .join('\n')
      .trim()
  )).filter(Boolean).join('\n\n');
}

/** Presentation only: unknown action results remain available in technical details. */
export function cronRunResultView(value: unknown): {
  isAgentResult: boolean;
  urgency?: CronUrgency;
  summaryText?: string;
  artifacts: string[];
  alertReason?: string;
} {
  if (!isRecord(value) || typeof value.agentType !== 'string'
    || typeof value.prompt !== 'string' || typeof value.sessionId !== 'string') {
    return { isAgentResult: false, artifacts: [] };
  }
  const digest = isRecord(value.digest) ? value.digest : undefined;
  const source = typeof digest?.fullSummary === 'string' ? digest.fullSummary
    : typeof digest?.summary === 'string' ? digest.summary : '';
  const summaryText = readableText(source) || undefined;
  const parsed = parseUrgencyHeader(source);
  const declaredInDigest = parsed.urgency !== 'fyi' || declaresCronUrgencyQuiet(source);
  // Host normalizes an absent header to fyi. Do not invent a declared chip for it.
  const urgency = declaredInDigest
    ? parsed.urgency
    : isCronUrgency(value.urgency) && value.urgency !== 'fyi'
      ? value.urgency
      : undefined;
  const artifacts = Array.isArray(digest?.artifacts)
    ? [...new Set(digest.artifacts
      .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .map((artifact) => artifact.trim()))]
    : [];
  const alertReason = typeof value.alertReason === 'string'
    ? readableText(value.alertReason) || undefined
    : undefined;
  return {
    isAgentResult: true,
    urgency,
    summaryText,
    artifacts,
    alertReason,
  };
}
