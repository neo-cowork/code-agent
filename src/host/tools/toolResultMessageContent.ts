import type { ToolResult } from '../../shared/contract';

/** Keep the existing model-visible JSON in Message.content. The full results are stored in Message.toolResults. */
export function serializeToolResultsForModel(results: ToolResult[]): string {
  return JSON.stringify(results.map(({ userMessage: _userMessage, ...modelResult }) => modelResult));
}
