import path from 'node:path';
import type { Message } from '../../shared/contract/message';
import type { CronRunDigest } from '../../shared/cronRunDigest';

export interface CronRunArtifactContext {
  messages: readonly Pick<Message, 'role' | 'toolCalls' | 'toolResults'>[];
  workingDirectory?: string;
}

/** New run settlement only: keep model text and historical stored digests intact. */
export function filterReadOnlyCronArtifacts(digest: CronRunDigest, context: CronRunArtifactContext): CronRunDigest {
  const canonicalPath = (value: string): string => path.resolve(context.workingDirectory ?? '.', value);
  const calls = new Map(context.messages.flatMap((message) => message.toolCalls ?? []).map((call) => [call.id, call]));
  const reads = new Set<string>();
  const writes = new Set<string>();
  let hasUntrackedShellWrite = false;
  for (const message of context.messages) {
    for (const result of message.toolResults ?? []) {
      if (!result.success) continue;
      const call = calls.get(result.toolCallId);
      if (!call) continue;
      const name = call.name.toLowerCase();
      // Shell effects have no per-file provenance in these messages. Preserve
      // candidates rather than mislabel a file changed through a command as input-only.
      if (['bash', 'terminal_write', 'process', 'code_execute'].includes(name)) hasUntrackedShellWrite = true;
      const target = call.arguments.file_path ?? call.arguments.path ?? call.arguments.notebook_path;
      if (typeof target !== 'string' || !target.trim()) continue;
      if (name === 'read' || name === 'read_file') reads.add(canonicalPath(target));
      if (['write', 'write_file', 'edit', 'edit_file', 'append', 'append_file', 'notebookedit'].includes(name)) {
        writes.add(canonicalPath(target));
      }
    }
  }
  return {
    ...digest,
    artifacts: digest.artifacts.filter((artifact) => {
      if (hasUntrackedShellWrite) return true;
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(artifact)) return true;
      // Models sometimes append an explanatory parenthesis to the artifact path.
      const unquoted = artifact.replace(/^`(.*)`$/, '$1');
      const candidates = [unquoted, unquoted.replace(/\s*(?:（[^）]*）|\([^)]*\))$/, '')];
      return !candidates.some((candidate) => reads.has(canonicalPath(candidate)) && !writes.has(canonicalPath(candidate)));
    }),
  };
}
