import { AgentFailureCode, inferAgentFailureCode } from '../../shared/contract/agentFailure';
import { agentFailureReasonText } from './subagentFailureReason';
import { getSubagentContextStore } from '../context/subagentContextStore';
import { stripWorkdirPrefix } from './workdirPrefix';
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
    task: stripWorkdirPrefix(prompt),
    background: Boolean(context.events.detached),
    backgroundAgentId: context.events.backgroundDurableAgentId,
    startedAt,
  };
  store.upsert({ sessionId: context.sessionId, agentId, messages: [], lifecycle, updatedAt: startedAt });
  const finish = (status: 'completed' | 'failed' | 'cancelled', failureCode?: AgentFailureCode): void => {
    const record = store.get(context.sessionId, agentId);
    const finishedAt = Date.now();
    store.upsert({
      ...(record ?? { sessionId: context.sessionId, agentId, messages: [] }),
      lifecycle: {
        ...lifecycle, status, background: Boolean(context.events.detached), finishedAt,
        ...(failureCode && { failureCode, failureReason: agentFailureReasonText(failureCode) }),
      },
      updatedAt: finishedAt,
    });
  };
  try {
    const result = await run();
    const failureCode = result.success ? undefined : inferAgentFailureCode(result);
    finish(result.success ? 'completed' : result.cancellationReason ? 'cancelled' : 'failed', failureCode);
    return result;
  } catch (error) {
    finish('failed', inferAgentFailureCode({ error }));
    throw error;
  }
}

/** The registry can settle a detached execution differently from the executor (e.g. no conclusion). */
export function persistBackgroundSubagentFailure(
  sessionId: string,
  agentId: string,
  failureCode: AgentFailureCode,
  finishedAt: number,
): void {
  const store = getSubagentContextStore();
  const record = store.get(sessionId, agentId)
    ?? store.list(sessionId).find((candidate) => candidate.lifecycle?.backgroundAgentId === agentId);
  if (!record?.lifecycle) return;
  const cancelled = record.lifecycleStatus === 'cancelled'
    || failureCode === AgentFailureCode.CancelledByUser || failureCode === AgentFailureCode.CancelledByParent;
  store.upsert({
    ...record,
    lifecycle: {
      ...record.lifecycle,
      background: true,
      status: cancelled ? 'cancelled' : 'failed',
      finishedAt,
      failureCode,
      failureReason: agentFailureReasonText(failureCode),
    },
    updatedAt: finishedAt,
  });
}
