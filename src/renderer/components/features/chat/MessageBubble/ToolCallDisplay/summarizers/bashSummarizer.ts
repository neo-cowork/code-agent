// ============================================================================
// Bash Summarizer - Smart summaries for bash command output
// ============================================================================

import type { ToolCall } from '@shared/contract';
import type { Translations } from '../../../../../../i18n';
import { interpolate } from '../../../../../../i18n/interpolate';

export function summarizeBash(toolCall: ToolCall, t: Translations): string | null {
  const output = toolCall.result?.output;
  const text = t.toolResultSummary;
  if (!output) return text.done;

  const outputStr = String(output).trim();
  const lines = outputStr.split('\n');

  // Extract command for context
  const command = String(toolCall.arguments?.command || '');

  // npm test output
  if (command.includes('npm test') || command.includes('jest') || command.includes('vitest')) {
    const passMatch = outputStr.match(/(\d+)\s*pass/i);
    const failMatch = outputStr.match(/(\d+)\s*fail/i);
    if (passMatch || failMatch) {
      const parts = [];
      if (passMatch) parts.push(interpolate(text.testsPassed, { count: passMatch[1] }));
      if (failMatch) parts.push(interpolate(text.testsFailed, { count: failMatch[1] }));
      return parts.join(', ');
    }
  }

  // npm install output
  if (command.includes('npm install') || command.includes('npm i ')) {
    const addedMatch = outputStr.match(/added (\d+) packages/);
    if (addedMatch) {
      return interpolate(text.packagesAdded, { count: addedMatch[1] });
    }
    const upToDateMatch = outputStr.match(/up to date/i);
    if (upToDateMatch) {
      return text.upToDate;
    }
  }

  // npm run build
  if (command.includes('npm run build') || command.includes('npm build')) {
    if (outputStr.includes('successfully') || outputStr.includes('Done in')) {
      return text.buildSucceeded;
    }
  }

  // git status
  if (command.includes('git status')) {
    if (outputStr.includes('nothing to commit')) {
      return text.noChanges;
    }
    const modifiedMatch = outputStr.match(/modified:\s+(\d+)/);
    if (modifiedMatch) {
      return interpolate(text.modifiedCount, { count: modifiedMatch[1] });
    }
    if (outputStr.includes('Changes not staged')) {
      return text.uncommittedChanges;
    }
  }

  // git commit
  if (command.includes('git commit')) {
    const commitMatch = outputStr.match(/\[[\w-]+\s+([a-f0-9]+)\]/);
    if (commitMatch) {
      return interpolate(text.committed, { ref: commitMatch[1].slice(0, 7) });
    }
  }

  // git push
  if (command.includes('git push')) {
    if (outputStr.includes('Everything up-to-date')) {
      return text.upToDate;
    }
    if (outputStr.includes('->')) {
      return text.pushed;
    }
  }

  // tsc / typecheck
  if (command.includes('tsc') || command.includes('typecheck')) {
    if (outputStr.length === 0 || outputStr.includes('0 errors')) {
      return text.noErrors;
    }
    const errorMatch = outputStr.match(/(\d+)\s*error/i);
    if (errorMatch) {
      return interpolate(text.errorCount, { count: errorMatch[1] });
    }
  }

  // ls output - count files
  if (command.match(/^ls(\s|$)/)) {
    const items = lines.filter(l => l.trim().length > 0);
    if (items.length <= 5) {
      return items.join(', ');
    }
    return interpolate(text.itemCount, { count: items.length });
  }

  // pwd output
  if (command === 'pwd') {
    return shortenPath(outputStr);
  }

  // Short output - display directly
  if (lines.length === 1 && lines[0].length < 60) {
    return lines[0];
  }

  // Multi-line output - show line count
  return text.lineCount.replace('{count}', String(lines.length));
}

function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-2).join('/');
}
