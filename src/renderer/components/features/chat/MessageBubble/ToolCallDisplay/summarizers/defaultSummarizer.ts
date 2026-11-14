// ============================================================================
// Default Summarizer - Fallback summaries for other tools
// ============================================================================

import type { ToolCall } from '@shared/contract';
import type { Translations } from '../../../../../../i18n';
import { interpolate } from '../../../../../../i18n/interpolate';

export function summarizeDefault(toolCall: ToolCall, t: Translations): string | null {
  const text = t.toolResultSummary;
  const output = toolCall.result?.output;

  // No output
  if (!output) return text.done;

  // Object type
  if (typeof output === 'object') {
    // Check for common message fields
    if ('message' in output) {
      return String((output as Record<string, unknown>).message).slice(0, 60);
    }
    // Check for count field
    if ('count' in output) {
      return interpolate(text.itemCount, { count: String((output as Record<string, unknown>).count) });
    }
    // Check for files field
    if ('files' in output && Array.isArray((output as Record<string, unknown>).files)) {
      const files = (output as Record<string, unknown>).files as unknown[];
      return interpolate(text.fileCount, { count: files.length });
    }
    return text.done;
  }

  // String type
  const str = String(output).trim();
  if (str.length === 0) return text.done;

  // Short single-line output - display directly
  if (str.length < 60 && !str.includes('\n')) {
    return str;
  }

  // Multi-line - just say Done
  return text.done;
}
