// ============================================================================
// Grep Summarizer - Smart summaries for grep search results
// ============================================================================

import type { ToolCall } from '@shared/contract';
import type { Translations } from '../../../../../../i18n';
import { interpolate } from '../../../../../../i18n/interpolate';
import { RAW_NO_MATCHES_SUMMARY } from './globSummarizer';

export function summarizeGrep(toolCall: ToolCall, t: Translations): string | null {
  const text = t.toolResultSummary;
  const output = toolCall.result?.output;
  if (!output) return RAW_NO_MATCHES_SUMMARY;

  // Handle structured output format (files array)
  if (typeof output === 'object' && output !== null && 'files' in output) {
    const files = (output as { files: string[] }).files;
    if (files.length === 0) return RAW_NO_MATCHES_SUMMARY;

    const firstFile = shortenPath(files[0]);
    if (files.length === 1) {
      return interpolate(text.foundOneResultIn, { where: firstFile });
    }
    return interpolate(text.foundResults, { count: files.length });
  }

  // Handle text output
  const outputStr = String(output).trim();
  if (!outputStr) return RAW_NO_MATCHES_SUMMARY;
  if (/^(?:No matches found|No matches|0 matches)\b/i.test(outputStr)) return RAW_NO_MATCHES_SUMMARY;

  const lines = outputStr.split('\n').filter(Boolean);
  if (lines.length === 0) return RAW_NO_MATCHES_SUMMARY;

  // Extract file path from first match (format: file:line:content)
  const firstMatch = lines[0];
  const colonIndex = firstMatch.indexOf(':');

  if (colonIndex > 0) {
    const filePath = firstMatch.slice(0, colonIndex);
    const lineNum = extractLineNumber(firstMatch.slice(colonIndex + 1));

    if (lines.length === 1) {
      return interpolate(text.foundOneResultIn, { where: `${shortenPath(filePath)}${lineNum ? `:${lineNum}` : ''}` });
    }
    return interpolate(text.foundResults, { count: lines.length });
  }

  // If no file path pattern, just count matches
  if (lines.length === 1) {
    return text.foundOneResult;
  }
  return interpolate(text.foundResults, { count: lines.length });
}

function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-2).join('/');
}

function extractLineNumber(str: string): string | null {
  const match = str.match(/^(\d+):/);
  return match ? match[1] : null;
}
