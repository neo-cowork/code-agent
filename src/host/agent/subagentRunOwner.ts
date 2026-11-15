import { isAgentWorktreePath } from './agentWorktreePath';
import { resolveBackgroundWorkspaceAuthority } from '../runtime/workspaceAuthority';
import { getConfiguredApplicationRunRegistry } from '../app/applicationRunRegistry';
import type { SubagentExecutionRequest, SubagentResult } from './subagentExecutorTypes';

/** Surface-capable lanes own an auxiliary run, never the foreground control slot. */
export async function withSubagentRunOwner(
  request: SubagentExecutionRequest,
  execute: (request: SubagentExecutionRequest) => Promise<SubagentResult>,
): Promise<SubagentResult> {
  const { context, config } = request;
  const registry = getConfiguredApplicationRunRegistry();
  if (!registry || !config.availableTools.includes('Browser')) return execute(request);

  const worktreeWorkspace = isAgentWorktreePath(context.cwd) ? context.cwd : undefined;
  const controller = new AbortController();
  const handle = registry.startAuxiliary({
    sessionId: context.sessionId,
    workspace: worktreeWorkspace ?? context.workspace ?? context.cwd,
    workspaceScope: worktreeWorkspace
      ? resolveBackgroundWorkspaceAuthority({ workspace: worktreeWorkspace })
      : context.workspaceScope,
    cwd: context.cwd,
  });
  const cancel = () => { void handle.cancel(); };
  try {
    await handle.attach({ cancel: () => controller.abort(context.abortSignal.reason) });
    context.abortSignal.addEventListener('abort', cancel, { once: true });
    if (context.abortSignal.aborted) await handle.cancel();
    return await execute({
      ...request,
      context: {
        ...context,
        runId: handle.context.runId,
        parentNativeRunId: context.parentNativeRunId ?? context.runId,
        abortSignal: controller.signal,
      },
    });
  } finally {
    context.abortSignal.removeEventListener('abort', cancel);
    registry.unregister(handle.context.runId, handle);
  }
}
