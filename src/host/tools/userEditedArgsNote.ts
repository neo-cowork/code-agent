import { detectStructuredToolFailure } from '../agent/runtime/toolResultNormalization';
import { formatConnectorTime } from './modules/connectors/connectorTime';
import type { ToolExecutionResult } from './types';

const MAX_VALUE_LENGTH = 500;
const FIELD_LABELS: Readonly<Record<string, string>> = {
  to: 'To',
  cc: 'CC',
  bcc: 'BCC',
  content: 'Body',
  start: 'Start time',
  start_ms: 'Start time',
  end: 'End time',
  end_ms: 'End time',
  remind_at_ms: 'Reminder time',
};

export function appendUserEditedArgsNote(
  result: ToolExecutionResult,
  args: Record<string, unknown>,
  changedKeys: readonly string[],
): ToolExecutionResult {
  if (!result.success || changedKeys.length === 0 || detectStructuredToolFailure(result.output)) return result;

  const lines = changedKeys.map((key) => {
    const label = FIELD_LABELS[key] ?? key[0].toUpperCase() + key.slice(1);
    const value = args[key];
    const display = typeof value === 'number' && key.endsWith('_ms')
      ? formatConnectorTime(value)
      : JSON.stringify(value);
    if (display.length > MAX_VALUE_LENGTH) {
      return `- ${label} (truncated preview): ${display.slice(0, MAX_VALUE_LENGTH - 1)}…`;
    }
    return `- ${label}: ${display}`;
  });
  const note = [
    'The user edited these fields on the approval card. Report the executed values below in place of the ones you proposed.',
    ...lines,
  ].join('\n');
  return { ...result, output: result.output ? `${result.output}\n\n${note}` : note };
}
