// ============================================================================
// Read Summarizer - Smart summaries for read_file results
// ============================================================================

import type { ToolCall } from '@shared/contract';
import type { Translations } from '../../../../../../i18n';

export function summarizeRead(toolCall: ToolCall, t: Translations): string | null {
  const output = toolCall.result?.output;
  if (!output) return null;

  const content = String(output);
  const lines = content.split('\n').length;

  // Add file size estimate for context
  const charCount = content.length;
  if (charCount > 10000) {
    return t.toolResultSummary.readLinesWithSize
      .replace('{count}', String(lines))
      .replace('{size}', String(Math.round(charCount / 1024)));
  }

  return t.toolResultSummary.readLines.replace('{count}', String(lines));
}
