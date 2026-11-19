import { isAgentWorktreePath } from './agentWorktreePath';
import { resolveBackgroundWorkspaceAuthority } from '../runtime/workspaceAuthority';
import { getConfiguredApplicationRunRegistry } from '../app/applicationRunRegistry';
import { createLogger } from '../services/infra/logger';
import { getConfiguredSurfaceExecutionRuntime } from '../services/surfaceExecution/SurfaceExecutionRuntime';
import type { SubagentExecutionRequest, SubagentResult } from './subagentExecutorTypes';

const logger = createLogger('SubagentRunOwner');

/**
 * Browser work inside this lane is bound to the auxiliary run id, not the
 * parent run. The parent finalizer only ends its own run id, so the surface
 * session has to be released here, while this handle is still the owner.
 */
async function endAuxiliarySurfaceRun(input: {
  conversationId: string;
  runId: string;
  agentId?: string;
}): Promise<void> {
  const runtime = getConfiguredSurfaceExecutionRuntime();
  const conversationId = input.conversationId.trim();
  const agentId = (input.agentId || 'surface-auxiliary-run').trim();
  if (!runtime || !conversationId || !input.runId || !agentId) return;
  try {
    await runtime.endRun({ conversationId, runId: input.runId, agentId });
  } catch (error) {
    logger.warn('Surface session was not ended with the auxiliary run', {
      conversationId,
      runId: input.runId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

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
    await endAuxiliarySurfaceRun({
      conversationId: context.sessionId,
      runId: handle.context.runId,
      agentId: context.executionAgentId || context.agentId || context.spawnGuardId,
    });
    registry.unregister(handle.context.runId, handle);
  }
}
