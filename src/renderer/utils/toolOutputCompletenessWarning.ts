// ============================================================================
// Tool Output Completeness Warning Replacement (N-FIX-ERROR-CARD-AI-DIRECTIVES-LEAK)
// ============================================================================
// Write (`write.ts`) and Edit (`multiEdit.ts`) append an AI-facing completeness
// warning block starting with `⚠️ **代码完整性警告**` to `result.output` on
// SUCCESS, alongside `completenessIssues` in `result.metadata` (or nested in
// `result.metadata.artifact.metadata`).
//
// Host keeps `result.output` untouched so the model still receives the repair
// instruction in the next turn. On the renderer side, when non-empty
// `completenessIssues` is present in metadata, we cut the AI-facing warning
// block from `⚠️ **代码完整性警告**` to the end and replace it with a
// plain-language user note.
// ============================================================================

const COMPLETENESS_WARNING_MARKER = '⚠️ **代码完整性警告**';
const COMPLETENESS_WARNING_TOOL_NAMES = new Set(['Write', 'Edit', 'write_file', 'edit_file']);

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

export function hasCompletenessIssues(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  if (isNonEmptyArray(metadata.completenessIssues)) return true;
  const artifact = metadata.artifact;
  if (artifact && typeof artifact === 'object') {
    const artifactMeta = (artifact as Record<string, unknown>).metadata;
    if (artifactMeta && typeof artifactMeta === 'object') {
      if (isNonEmptyArray((artifactMeta as Record<string, unknown>).completenessIssues)) {
        return true;
      }
    }
  }
  return false;
}

export function replaceCompletenessWarningInOutput(
  toolName: string,
  output: string,
  metadata: Record<string, unknown> | null | undefined,
  replacementNote: string,
  preservePrefix = true,
): string {
  if (!COMPLETENESS_WARNING_TOOL_NAMES.has(toolName) || !output || !hasCompletenessIssues(metadata)) {
    return output;
  }
  const markerIndex = output.indexOf(COMPLETENESS_WARNING_MARKER);
  if (markerIndex < 0) return output;
  if (!preservePrefix) return replacementNote;
  const prefix = output.slice(0, markerIndex).trimEnd();
  if (!prefix) return replacementNote;
  return `${prefix}\n\n${replacementNote}`;
}
