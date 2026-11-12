import type { SwarmRunScope } from '../../shared/contract/swarm';
import type { SubagentExecutionContext } from './subagentExecutorTypes';
import { AgentFailureCode } from '../../shared/contract/agentFailure';
import { type AgentTask, type AgentTaskResult, type CoordinatorConfig } from './parallelAgentCoordinatorTypes';
import type { AgentTeamDurableController } from './agentTeamDurableTypes';
import { type GraphCheckpoint, type GraphNode, type GraphRunSpec } from '../orchestration';

export function createSkippedParallelResult(
    task: AgentTask,
    reason: string,
    type: 'blocked' | 'cancelled',
    failureCode: AgentFailureCode,
  ): AgentTaskResult {
    const now = Date.now();
    return {
      success: false,
      output: '',
      error: reason,
      toolsUsed: [],
      iterations: 0,
      taskId: task.id,
      role: task.role,
      startTime: now,
      endTime: now,
      duration: 0,
      blocked: type === 'blocked',
      cancelled: type === 'cancelled',
      failureCode,
    };
  }


export function buildParallelGraphSpec(tasks: AgentTask[], executionContext: SubagentExecutionContext, config: CoordinatorConfig, scope?: SwarmRunScope, durableController?: AgentTeamDurableController): GraphRunSpec {
    const runId = scope?.runId ?? executionContext.runId ?? `parallel:${executionContext.sessionId}`;
    const sessionId = scope?.sessionId ?? executionContext.sessionId;
    const treeId = scope?.treeId ?? executionContext.spawnTreeId ?? sessionId;
    const attempt = durableController?.traceContext?.attempt ?? executionContext.traceContext?.attempt ?? 1;
    const durableNodes = new Map(durableController?.getState().taskGraph.map((node) => [node.id, node]) ?? []);
    const nodes: GraphNode[] = tasks.map((task) => {
      const durable = durableNodes.get(task.id);
      const sideEffect = durable?.sideEffect ?? task.tools.some((tool) => /(write|edit|bash|shell|browser|computer)/i.test(tool));
      return {
        nodeId: task.id,
        kind: 'subagent',
        executorRef: 'parallel-subagent',
        input: {
          role: task.role,
          task: task.task,
          tools: [...task.tools],
          ...(task.systemPrompt ? { systemPrompt: task.systemPrompt } : {}),
        },
        dependencies: [...(task.dependsOn ?? [])],
        permissionProfile: durable?.permissionProfile ?? 'readonly',
        capabilityProfile: { tools: [...task.tools] },
        sideEffect: sideEffect ? 'unknown' : 'read_only',
        idempotencyIdentity: `${runId}:node:${task.id}`,
        timeoutMs: config.taskTimeout,
        retryPolicy: { maxAttempts: 1 },
        required: true,
        priority: task.priority,
        metadata: { role: task.role, treeId },
      };
    });
    const trace = durableController?.traceContext ?? executionContext.traceContext;
    return {
      graphId: `agent-team:${treeId}`,
      runId,
      sessionId,
      attempt,
      nodes,
      schedulerPolicy: {
        maxConcurrency: config.maxParallelTasks,
        failureStrategy: 'continue',
        priority: 'priority',
      },
      metadata: { engine: 'agent_team', treeId },
      ...(trace ? { trace: { traceId: trace.traceId, spanId: trace.spanId } } : {}),
    };
  }


export function compatibleParallelGraphCheckpoint(spec: GraphRunSpec, checkpoint?: GraphCheckpoint): GraphCheckpoint | undefined {
if (!checkpoint) return undefined;
    const expected = new Set(spec.nodes.map((node) => node.nodeId));
    const actual = new Set(checkpoint.nodes.map((node) => node.nodeId));
    if (
      checkpoint.graphId !== spec.graphId
      || checkpoint.runId !== spec.runId
      || checkpoint.sessionId !== spec.sessionId
      || checkpoint.attempt !== spec.attempt
      || expected.size !== actual.size
      || [...expected].some((nodeId) => !actual.has(nodeId))
    ) return undefined;
    return checkpoint;
  }

