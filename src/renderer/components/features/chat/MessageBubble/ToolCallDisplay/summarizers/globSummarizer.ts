// ============================================================================
// Glob Summarizer - Smart summaries for glob search results
// ============================================================================

import type { ToolCall } from '@shared/contract';
import type { Translations } from '../../../../../../i18n';
import { interpolate } from '../../../../../../i18n/interpolate';

/** Raw sentinel kept in English: ResultSummary recognises it to avoid repeating the status line. */
export const RAW_NO_MATCHES_SUMMARY = 'No matches';

export function summarizeGlob(toolCall: ToolCall, t: Translations): string | null {
  const text = t.toolResultSummary;
  const output = toolCall.result?.output;
  if (!output) return RAW_NO_MATCHES_SUMMARY;

  // Handle array output
  if (Array.isArray(output)) {
    if (output.length === 0) return RAW_NO_MATCHES_SUMMARY;
    if (output.length === 1) {
      return interpolate(text.foundOneFile, { path: shortenPath(String(output[0])) });
    }
    return interpolate(text.foundFiles, { count: output.length });
  }

  // Handle string output (newline separated)
  const outputStr = String(output).trim();
  if (!outputStr) return RAW_NO_MATCHES_SUMMARY;
  if (/^(?:No files matched the pattern|No matches)\b/i.test(outputStr)) return RAW_NO_MATCHES_SUMMARY;

  const lines = outputStr.split('\n').filter(Boolean);
  if (lines.length === 0) return RAW_NO_MATCHES_SUMMARY;

  if (lines.length === 1) {
    return interpolate(text.foundOneFile, { path: shortenPath(lines[0]) });
  }
  return interpolate(text.foundFiles, { count: lines.length });
}

function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-2).join('/');
}
