import type { CronUrgency } from '@shared/contract/sessionAutomation';
import { splitCronRunMessage } from '@shared/cronRunMessage';
import { isCronUrgency, parseUrgencyHeader } from '@shared/cronUrgency';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readableMessage(source: string): { text: string; artifacts: string[] } {
  const artifacts: string[] = [];
  const text = splitCronRunMessage(source).map((segment) => {
    artifacts.push(...segment.artifacts);
    // The shared splitter removes these lines inside summary blocks only.
    return segment.text.split(/\r?\n/).filter((line) => {
      if (/^\s*urgency\s*:/i.test(line)) return false;
      const artifact = line.match(/^\s*artifact:\s*(\S.*)?\s*$/i);
      if (!artifact) return true;
      if (artifact[1]?.trim()) artifacts.push(artifact[1].trim());
      return false;
    }).join('\n').trim();
  }).filter(Boolean).join('\n\n');
  return { text, artifacts };
}

/** Presentation only: unknown action results remain available in technical details. */
export function cronRunResultView(value: unknown): {
  urgency?: CronUrgency;
  summaryText?: string;
  artifacts: string[];
  alertReason?: string;
} {
  if (!isRecord(value) || typeof value.agentType !== 'string'
    || typeof value.prompt !== 'string' || typeof value.sessionId !== 'string') {
    return { artifacts: [] };
  }
  const digest = isRecord(value.digest) ? value.digest : undefined;
  const source = typeof digest?.fullSummary === 'string' ? digest.fullSummary
    : typeof digest?.summary === 'string' ? digest.summary
      : typeof value.result === 'string' ? value.result : '';
  const summary = readableMessage(source);
  const header = source.split(/\r?\n/).filter((line) => line.trim()).slice(0, 3)
    .find((line) => /^\s*urgency\s*:\s*(must_today|can_wait|fyi)\s*$/i.test(line));
  // Host normalizes an absent header to fyi. Do not invent a declared chip for it.
  const urgency = header ? parseUrgencyHeader(header).urgency
    : isCronUrgency(value.urgency) && value.urgency !== 'fyi' ? value.urgency : undefined;
  // A stored digest is authoritative: host may have filtered read-only artifacts.
  const artifacts = digest && Array.isArray(digest.artifacts)
    ? digest.artifacts.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : summary.artifacts;
  const alertReason = typeof value.alertReason === 'string'
    ? readableMessage(value.alertReason).text : undefined;
  return {
    urgency,
    summaryText: summary.text || undefined,
    artifacts: [...new Set(artifacts.map((artifact) => artifact.trim()))],
    alertReason: alertReason || undefined,
  };
}
