import type { ToolResult } from '../../shared/contract';

/**
 * Text the model reads for one tool result. `metadata.modelGuidance` is an instruction written for the model; it
 * is kept out of the stored, user-visible `output` and joined back here, on the model side only. A guidance that
 * is itself the complete answer (`modelGuidanceReplacesOutput`) replaces the fact line, as the old combined
 * output did; otherwise it leads the output. Real runs showed the model ignores guidance that only sits in
 * metadata (the providers send `output`, not metadata) or trails a fact line, and then names the wrong place.
 */
export function modelVisibleToolOutput(result: Pick<ToolResult, 'output' | 'error' | 'metadata'>): string {
  const guidance = result.metadata?.modelGuidance;
  if (typeof guidance !== 'string' || !guidance) return result.output || result.error || '';
  if (result.metadata?.modelGuidanceReplacesOutput === true || !result.output) return guidance;
  return `${guidance}\n\n${result.output}`;
}

/** Keep the existing model-visible JSON in Message.content. The full results are stored in Message.toolResults. */
export function serializeToolResultsForModel(results: ToolResult[]): string {
  return JSON.stringify(results.map(({ userMessage: _userMessage, ...modelResult }) => {
    const { modelGuidance, modelGuidanceReplacesOutput: _replaces, ...metadata } = modelResult.metadata ?? {};
    if (typeof modelGuidance !== 'string') return modelResult;
    return { ...modelResult, output: modelVisibleToolOutput(modelResult), metadata };
  }));
}
