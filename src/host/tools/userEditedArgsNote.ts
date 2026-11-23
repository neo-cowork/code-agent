import { detectStructuredToolFailure } from '../agent/runtime/toolResultNormalization';
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
      ? new Date(value).toISOString()
      : JSON.stringify(value);
    const preview = display.length > MAX_VALUE_LENGTH
      ? `${display.slice(0, MAX_VALUE_LENGTH - 1)}…`
      : display;
    return `- ${label}: ${preview}`;
  });
  const note = [
    'The user edited these fields on the approval card. Report the executed values below in place of the ones you proposed.',
    ...lines,
  ].join('\n');
  return { ...result, output: result.output ? `${result.output}\n\n${note}` : note };
}
