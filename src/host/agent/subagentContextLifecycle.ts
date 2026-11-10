import { getSubagentContextStore } from '../context/subagentContextStore';
import type { SubagentExecutionRequest, SubagentResult } from './subagentExecutorTypes';

/** Every executor exit records the same lifecycle facts used by the panel and task_status. */
export async function withPersistedSubagentLifecycle(
  request: SubagentExecutionRequest,
  run: () => Promise<SubagentResult>,
): Promise<SubagentResult> {
  const { context, config, prompt } = request;
  // agentId may identify the caller of a nested tool, not this execution.
  const agentId = context.executionAgentId || context.spawnGuardId;
  if (context.suppressContextPublishing || !context.sessionId || !agentId) return run();
  const store = getSubagentContextStore();
  const startedAt = Date.now();
  const lifecycle = {
    status: 'running' as const,
    displayName: config.name,
    role: config.roleId,
    task: prompt,
    background: Boolean(context.events.detached),
    backgroundAgentId: context.events.backgroundDurableAgentId,
    startedAt,
  };
  store.upsert({ sessionId: context.sessionId, agentId, messages: [], lifecycle, updatedAt: startedAt });
  const finish = (status: 'completed' | 'failed' | 'cancelled'): void => {
    const record = store.get(context.sessionId, agentId);
    const finishedAt = Date.now();
    store.upsert({
      ...(record ?? { sessionId: context.sessionId, agentId, messages: [] }),
      lifecycle: { ...lifecycle, status, background: Boolean(context.events.detached), finishedAt },
      updatedAt: finishedAt,
    });
  };
  try {
    const result = await run();
    finish(result.success ? 'completed' : result.cancellationReason ? 'cancelled' : 'failed');
    return result;
  } catch (error) {
    finish('failed');
    throw error;
  }
}
