import { executeSingleSpawnAgent } from './spawnSingleAgent';
// ============================================================================
// Spawn Agent — execute helpers
// Gen 7: Multi-Agent capability
//
// P1 Wave 3 multiagent native: 原 spawnAgentTool / agentSpawnTool (legacy Tool)
// 已删除，protocol 入口在 src/host/tools/modules/multiagent/spawnAgent.ts。
// 本文件仅保留：
//   - executeSpawnAgent(params, ctx)  — single + parallel mode 入口
//   - getSpawnedAgent / listSpawnedAgents / SpawnedAgent
//     已拆至 ./spawnAgentStatus.ts（N-SUBAGENT-ZEROTOOLS 返修：max-lines 硬限）
//   - DEFAULT_ISOLATION map
// ============================================================================

import {
  AgentFailureCode,
  inferAgentFailureCode,
} from '../../../shared/contract/agentFailure';
import { routeFailureCode } from '../../../shared/contract/cancellation';
import {
  createScopedSwarmAgentId,
  type SwarmRunScope,
} from '../../../shared/contract/swarm';
import {
  buildAgentTeamFailureRecoveryProposal,
  buildRecoveryPriorProjection,
  recordLongTaskRecoveryProposal,
} from '../../handoff/longTaskRecoveryProposal';
import { bindBrowserPoolReleaseHook } from '../../services/infra/browserPool';
import { bindFileOwnershipReleaseHook } from '../../services/infra/fileOwnershipRegistry';
import { withRunTraceContext } from '../../telemetry/runTraceContext';
import {
  getAgentMaxIterations,
  getAgentPrompt,
  getAgentTools,
  getPredefinedAgent,
  listPredefinedAgents,
} from '../agentDefinition';
import {
  stableAgentTeamRunId,
} from '../agentTeamDurableAdapter';
import {
  prepareAgentTeamDurableController,
  requestDurableAgentTeamLaunchApproval,
} from '../agentTeamDurableLaunch';
import type { AgentTeamDurableController } from '../agentTeamDurableTypes';
import { createAgentTeamGraphCompatibility } from '../agentTeamGraphCompatibility';
import {
  createCoordinatorSession,
  shouldActivateCoordinator,
} from '../coordinatorMode';
import { applyCacheControl, buildForkContexts, shouldUseForkMode } from '../forkContext.js';
import { SUBAGENT_SUFFIXES, isCoreAgent, type CoreAgentId } from '../hybrid/coreAgents';
import type { MultiagentExecutionResult } from '../multiagentExecutionTypes';
import {
  getParallelAgentCoordinator,
  getParallelAgentCoordinatorRegistry,
  type AgentTask,
  type ParallelCoordinatorTerminalStatus,
} from '../parallelAgentCoordinator';
import { resolveAgentDisplayNames } from '../resolveAgentDisplayNames';
import { aggregateTeamResults } from '../resultAggregator';
import { isToolWriteReadonlyRole } from '../routingToolPolicy';
import { getSpawnGuard } from '../spawnGuard';
import type { SubagentExecutionContext } from '../subagentExecutorTypes';
import { getSwarmEventEmitter } from '../swarmEventPublisher';
import { detectCycles, validateNoCycles } from '../taskDag.js';
import { getParallelCancellationResult, isCancelledTaskError } from './parallelCancellation';
import { SWARM_STATUS_REPORT_SUFFIX, parseStatusReport } from './statusReport';

/**
 * spawn_agent / AgentSpawn protocol-native execution service.
 */
export async function executeSpawnAgent(
  params: Record<string, unknown>,
  context: SubagentExecutionContext,
): Promise<MultiagentExecutionResult> {
    const parallel = params.parallel as boolean | undefined;
    const agents = params.agents as Array<{ role: string; task: string; name?: string; maxBudget?: number; dependsOn?: string[]; ownedPaths?: string[] }> | undefined;

    // Check for required context
    if (!context.modelConfig) {
      return {
        success: false,
        error: 'spawn_agent requires modelConfig in context',
        metadata: {
          failureCode: AgentFailureCode.ModelError,
        },
      };
    }

    const guard = getSpawnGuard();
    bindFileOwnershipReleaseHook(guard);
    // Legacy pool keys are the agent id. Release that entry when the agent finishes.
    bindBrowserPoolReleaseHook(guard);

    // ========================================================================
    // spawn 嵌套深度截断（执行层防线）
    // ========================================================================
    const parentDepth = context.spawnDepth ?? 0;
    const childDepth = parentDepth + 1;
    const maxDepth = guard.getMaxDepth(context.spawnMaxDepth);
    if (!guard.checkDepth(childDepth, context.spawnMaxDepth)) {
      return {
        success: false,
        error: `DEPTH_LIMIT: spawn 嵌套深度超限（current depth ${childDepth} exceeds maxDepth ${maxDepth}）。请改用本层已有上下文继续汇总，或让父 agent 重新拆分任务。`,
        metadata: {
          cancellationReason: 'depth-limit',
          failureRouting: routeFailureCode('depth-limit'),
          failureCode: inferAgentFailureCode({ cancellationReason: 'depth-limit' }),
          childDepth,
          maxDepth,
        },
      };
    }
    const treeId = context.swarmRunScope?.treeId || context.spawnTreeId || context.sessionId || 'default';

    // Handle parallel execution mode
    if (parallel && agents && agents.length > 0) {
      return executeParallelAgents(agents, {
        ...context,
        spawnDepth: childDepth,
        spawnMaxDepth: context.spawnMaxDepth,
        spawnTreeId: treeId,
        swarmRunScope: context.swarmRunScope,
        spawnQueueTimeoutMs: context.spawnQueueTimeoutMs,
        spawnParentStartedAt: context.spawnParentStartedAt,
        spawnParentTimeoutMs: context.spawnParentTimeoutMs,
        parentRemainingBudget: context.parentRemainingBudget,
        spawnParentAgentId: context.spawnParentAgentId,
      });
    }

    return executeSingleSpawnAgent(params, context, childDepth, treeId);
}

/**
 * Backward-compatible type for spawned agent status.
 * 已拆至 ./spawnAgentStatus.ts（max-lines 硬限），消费方直接从该文件 import。
 */

// AgentSpawn (PascalCase variant) shares execute body with spawn_agent — the
// schema-level distinction is now in spawnAgent.schema.ts. Both protocol entries
// dispatch to executeSpawnAgent above.

// Execute multiple agents in parallel using the ParallelAgentCoordinator
export async function launchAgentTeam(agents: Array<{ role: string; task: string; name?: string; maxBudget?: number; dependsOn?: string[]; ownedPaths?: string[] }>, context: SubagentExecutionContext): Promise<MultiagentExecutionResult> { return executeParallelAgents(agents, context); }

async function executeParallelAgents(
  agents: Array<{ role: string; task: string; name?: string; maxBudget?: number; dependsOn?: string[]; ownedPaths?: string[] }>,
  context: SubagentExecutionContext,
): Promise<MultiagentExecutionResult> {
  if (!context.sessionId) {
    return {
      success: false,
      error: 'Parallel Agent Team requires a sessionId for run isolation.',
      metadata: { failureCode: AgentFailureCode.ModelError },
    };
  }

  if (context.swarmRunScope && context.swarmRunScope.sessionId !== context.sessionId) {
    return {
      success: false,
      error: 'Inherited Agent Team scope does not match the active session.',
      metadata: { failureCode: AgentFailureCode.ModelError },
    };
  }
  const parentNativeRunId = context.swarmRunScope?.parentNativeRunId ?? context.runId;
  if (!parentNativeRunId) {
    return {
      success: false,
      error: 'Parallel Agent Team requires a Native Run identity.',
      metadata: { failureCode: AgentFailureCode.ModelError },
    };
  }
  if (context.runId && context.runId !== parentNativeRunId) {
    return {
      success: false,
      error: 'Inherited Agent Team scope does not match the active Native Run.',
      metadata: { failureCode: AgentFailureCode.ModelError },
    };
  }
  const logicalOperationId = context.currentToolCallId?.trim();
  if (!logicalOperationId) {
    return {
      success: false,
      error: 'Parallel Agent Team requires a stable logical tool call id for Durable Run recovery.',
      metadata: { failureCode: AgentFailureCode.ModelError },
    };
  }
  const newRunId = stableAgentTeamRunId(parentNativeRunId, logicalOperationId);
  const runScope: SwarmRunScope = {
    sessionId: context.sessionId,
    runId: newRunId,
    treeId: context.swarmRunScope?.treeId ?? newRunId,
    parentNativeRunId,
  };
  const emitter = getSwarmEventEmitter();
  const guard = getSpawnGuard();

  // ========================================================================
  // Task DAG: 依赖环检测（在 spawn 之前验证）
  // ========================================================================
  const hasDependencies = agents.some(a => a.dependsOn && a.dependsOn.length > 0);
  if (hasDependencies) {
    // 构建 dependencies map: taskId -> Set<blockerIds>
    // 使用 role_index 作为 taskId（与下方 tasks 映射一致）
    const depMap = new Map<string, Set<string>>();
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const taskId = createScopedSwarmAgentId(runScope, `agent_${agent.role}_${i}`);
      const blockers = new Set<string>();
      if (agent.dependsOn) {
        for (const dep of agent.dependsOn) {
          // 尝试将 role 名解析为 taskId（与下方 Phase 2 解析逻辑一致）
          const resolvedIdx = agents.findIndex(a => a.role === dep);
          const resolvedId = resolvedIdx >= 0
            ? createScopedSwarmAgentId(runScope, `agent_${dep}_${resolvedIdx}`)
            : dep;
          blockers.add(resolvedId);
        }
      }
      depMap.set(taskId, blockers);
    }

    if (!validateNoCycles(depMap)) {
      const cycles = detectCycles(depMap);
      const cycleStr = cycles.map(c => c.join(' → ')).join('; ');
      return {
        success: false,
        error: `Cannot spawn parallel agents: dependency cycle detected. Cycles: ${cycleStr}`,
      };
    }
  }

  // Convert to AgentTask format
  // Phase 1: 生成稳定的 ID 并建立 role→id 映射（用于解析 dependsOn）
  const roleToId = new Map<string, string>();
  const cwd = context.cwd;

  // Disabled tools lists
  const disabledTools = guard.getDisabledTools();
  const readonlyDisabledTools = guard.getReadonlyDisabledTools();
  // 工具写只读的角色名（供审批卡显示 writeAccess，与下面的工具过滤同一判定，避免两处口径不一）。
  const toolReadonlyRoleNames = new Set<string>();
  // A4：实例显示名 —— 模型 name 优先，同批 role 重复才 role-1/role-2
  const displayNames = resolveAgentDisplayNames(agents);

  const tasks: AgentTask[] = agents.map((agent, index) => {
    const agentConfig = getPredefinedAgent(agent.role);
    if (!agentConfig) {
      const availableIds = listPredefinedAgents().map(a => a.id);
      throw new Error(
        `Unknown agent: ${agent.role}. Available agents: ${availableIds.join(', ')}`
      );
    }

    // 使用 role_index 作为稳定 ID，避免 Date.now() 导致 dependsOn 无法匹配
    const taskId = createScopedSwarmAgentId(runScope, `agent_${agent.role}_${index}`);
    roleToId.set(agent.role, taskId);
    // 也支持 "role-index" 格式引用
    roleToId.set(`${agent.role}-${index}`, taskId);

    // 根据 task 内容过滤文档工具 — 代码任务不需要文档/Excel 专用读取工具
    const DOCUMENT_TOOLS = ['read_pdf', 'read_docx', 'read_xlsx', 'ReadDocument', 'ExcelAutomate'];
    const taskLower = agent.task.toLowerCase();
    const needsDocTools = DOCUMENT_TOOLS.some(t => taskLower.includes(t.toLowerCase()))
      || /\.(pdf|docx|xlsx|doc|xls)\b/.test(taskLower);
    let tools = getAgentTools(agentConfig);
    if (!needsDocTools) {
      tools = tools.filter(t => !DOCUMENT_TOOLS.includes(t));
    }

    // SpawnGuard: filter disabled tools (P2 + P3 readonly enforcement)
    // 工具写只读判定走单一真源，与单发路径 (site 1) 共用同一 helper。
    const isReadonly = isToolWriteReadonlyRole(agent.role, agentConfig);
    if (isReadonly) toolReadonlyRoleNames.add(agent.role.toLowerCase());
    const toolsToDisable = isReadonly ? readonlyDisabledTools : disabledTools;
    tools = tools.filter(t => !toolsToDisable.includes(t));

    // 注入 subagent suffix
    let systemPrompt = getAgentPrompt(agentConfig);
    if (isCoreAgent(agent.role)) {
      const suffix = SUBAGENT_SUFFIXES[agent.role as CoreAgentId];
      if (suffix) {
        systemPrompt += suffix;
      }
    }
    // 协作可见性（P1-3）：所有并行子代理统一自报 STATUS/DECISION，喂给讨论流
    systemPrompt += SWARM_STATUS_REPORT_SUFFIX;

    return {
      id: taskId,
      role: agent.role,
      name: displayNames[index],
      task: `[工作目录: ${cwd}] 所有文件路径基于此目录。\n\n${agent.task}`,
      systemPrompt,
      tools,
      maxIterations: getAgentMaxIterations(agentConfig),
      dependsOn: agent.dependsOn,
      ownedPaths: agent.ownedPaths,
    };
  });

  // Phase 2: 解析 dependsOn — 将 role 名称映射到实际 task ID
  for (const task of tasks) {
    if (task.dependsOn) {
      task.dependsOn = task.dependsOn.map(dep => {
        // 优先精确匹配 task ID
        if (tasks.some(t => t.id === dep)) return dep;
        // 再尝试 role→id 映射
        return roleToId.get(dep) || dep;
      });
    }
  }

  const durablePreparation = await prepareAgentTeamDurableController({
    scope: runScope, parentRunId: parentNativeRunId, logicalOperationId, tasks,
    modelConfig: context.modelConfig,
  });
  if ('result' in durablePreparation) return durablePreparation.result;
  const durableController: AgentTeamDurableController = durablePreparation.controller;

  // ========================================================================
  // Coordinator Mode: 3+ agent 时自动激活任务编排
  // ========================================================================
  let coordSession: ReturnType<typeof createCoordinatorSession> | undefined;
  if (shouldActivateCoordinator(tasks.length)) {
    coordSession = createCoordinatorSession();
    try {
      coordSession.decompose(
        tasks.map(t => t.task).join('\n'),
        tasks.map(t => ({
          id: t.id,
          description: t.task,
          dependsOn: t.dependsOn,
        }))
      );
    } catch {
      // decompose 失败（如循环依赖）不阻塞执行，上面已有独立的环检测
      coordSession = undefined;
    }
  }

  const cancelledBeforeApproval = getParallelCancellationResult(context.abortSignal);
  if (cancelledBeforeApproval) {
    await durableController.cancel('parent-cancel');
    await durableController.terminal('cancelled', 'parent-cancel');
    return cancelledBeforeApproval;
  }
  const coordinatorRegistry = getParallelAgentCoordinatorRegistry();
  const coordinator = getParallelAgentCoordinator(runScope);
  try {
    coordinator.initialize({
      executionContext: {
        ...context,
        spawnTreeId: runScope.treeId,
        swarmRunScope: runScope,
        // A nested parallel Team is a new run root. Parent cancellation is bridged
        // through abortSignal; carrying the parent run's agent id would create a
        // cross-run SpawnGuard edge.
        spawnParentAgentId: undefined,
      },
      scope: runScope,
      durableController,
    });
  } catch (error) {
    coordinatorRegistry.finalize(runScope, 'failed');
    await durableController.terminal('failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
  let launchApproval;
  try {
    launchApproval = await requestDurableAgentTeamLaunchApproval({
      controller: durableController,
      scope: runScope,
      tasks,
      readonlyRoles: [...toolReadonlyRoleNames],
      abortSignal: context.abortSignal,
    });
  } catch (error) {
    coordinatorRegistry.finalize(runScope, 'failed');
    await durableController.terminal('failed', error instanceof Error ? error.message : String(error));
    throw error;
  }

  const cancelledAfterApproval = getParallelCancellationResult(context.abortSignal);
  if (cancelledAfterApproval) {
    await durableController.cancel('parent-cancel');
    await durableController.terminal('cancelled', 'parent-cancel');
    coordinatorRegistry.finalize(runScope, 'cancelled');
    return cancelledAfterApproval;
  }

  if (!launchApproval.approved) {
    const reason = launchApproval.feedback?.trim();
    await durableController.cancel(reason || 'launch-rejected');
    await durableController.terminal('cancelled', reason || 'launch-rejected');
    coordinatorRegistry.finalize(runScope, 'cancelled');
    return {
      success: false,
      error: reason ? `Parallel launch rejected: ${reason}` : 'Parallel launch rejected by user',
    };
  }

  // ========================================================================
  // Fork Cache: 多 subagent 共享前缀，最大化 Prompt Cache 命中
  // ========================================================================
  if (shouldUseForkMode(tasks.length) && context.messages && context.messages.length > 0) {
    try {
      const childPrompts = tasks.map(t => t.task);
      const forkContexts = buildForkContexts({
        systemPrompt: tasks[0].systemPrompt || '',
        tools: [], // 工具定义由 executor 注入，此处仅用于缓存前缀
        messages: context.messages,
        childPrompts,
      });

      // 将 fork 后的 childDirective 回写到各 task
      for (let i = 0; i < tasks.length && i < forkContexts.length; i++) {
        tasks[i].task = forkContexts[i].childDirective;
      }

      // 对共享消息应用 cache_control 标记
      applyCacheControl(context.messages);
    } catch (err) {
      // Fork cache 失败不应阻止任务执行
      console.warn('[SpawnAgent] Fork cache setup failed, continuing without cache optimization:', err);
    }
  }

  const compatibility = createAgentTeamGraphCompatibility({ emitter, scope: runScope, tasks });

  // Bridge coordinator events to swarm events + coordinator session tracking
  const onTaskStart = (evt: { taskId: string; role: string }) => {
    emitter.agentUpdated(runScope, evt.taskId, { status: 'running', startTime: Date.now() });
    // Coordinator mode: 标记任务分配
    if (coordSession) {
      const coordTask = coordSession.getTask(evt.taskId);
      if (coordTask?.status === 'pending') {
        coordSession.assign(evt.taskId, evt.taskId);
      }
    }
  };
  const onTaskProgress = (evt: {
    taskId: string;
    role: string;
    snapshot: import('../../../shared/contract/swarm').SwarmAgentContextSnapshot;
  }) => {
    emitter.agentUpdated(runScope, evt.taskId, {
      status: 'running',
      contextSnapshot: evt.snapshot,
      toolCalls: evt.snapshot.tools.length,
    });
  };
  const onTaskComplete = (evt: { taskId: string; result: { success: boolean; duration: number; output?: string; error?: string } }) => {
    if (evt.result.success) {
      emitter.agentCompleted(runScope, evt.taskId, evt.result.output);
      coordSession?.complete(evt.taskId, evt.result.output ?? '');
      // 协作可见性（P1-3）：解析子代理自报的人话状态 / 决策 → 讨论流
      const report = parseStatusReport(evt.result.output ?? '');
      const reportRole = tasks.find((t) => t.id === evt.taskId)?.role;
      const reportAt = Date.now();
      if (report.status) {
        emitter.contextUpdate(runScope, { kind: 'status', agentId: evt.taskId, role: reportRole, content: report.status, at: reportAt });
      }
      if (report.decision) {
        emitter.contextUpdate(runScope, { kind: 'decision', agentId: evt.taskId, role: reportRole, content: report.decision, at: reportAt });
      }
    } else {
      const errorMessage = evt.result.error || 'Unknown error';
      if (isCancelledTaskError(errorMessage)) {
        emitter.agentUpdated(runScope, evt.taskId, {
          status: 'cancelled',
          endTime: Date.now(),
          error: 'Cancelled',
        });
      } else {
        emitter.agentFailed(runScope, evt.taskId, errorMessage);
      }
      coordSession?.fail(evt.taskId, errorMessage);
    }
  };
  const onTaskError = (evt: { taskId: string; error: string }) => {
    if (isCancelledTaskError(evt.error)) {
      emitter.agentUpdated(runScope, evt.taskId, {
        status: 'cancelled',
        endTime: Date.now(),
        error: 'Cancelled',
      });
    } else {
      emitter.agentFailed(runScope, evt.taskId, evt.error);
    }
    coordSession?.fail(evt.taskId, evt.error);
  };

  // 协作可见性（P1-3）：SharedContext 发现（discovery）桥接成讨论流事件
  const onDiscovery = (evt: { taskId?: string; role?: string; finding?: string; key?: string; value?: unknown; at?: number }) => {
    const content = evt.finding ?? (typeof evt.value === 'string' ? evt.value : evt.key);
    if (!content) return;
    emitter.contextUpdate(runScope, {
      kind: 'finding',
      agentId: evt.taskId,
      role: evt.role ?? (evt.taskId ? tasks.find((t) => t.id === evt.taskId)?.role : undefined),
      content,
      key: evt.key,
      at: evt.at ?? Date.now(),
    });
  };

  coordinator.on('task:start', onTaskStart);
  coordinator.on('task:progress', onTaskProgress);
  coordinator.on('task:complete', onTaskComplete);
  coordinator.on('task:error', onTaskError);
  coordinator.on('discovery', onDiscovery);

  const onRunAbort = () => coordinator.abortAllRunning('run_cancelled');
  if (context.abortSignal?.aborted) {
    onRunAbort();
  } else {
    context.abortSignal?.addEventListener('abort', onRunAbort, { once: true });
  }

  let terminalStatus: ParallelCoordinatorTerminalStatus | undefined;
  try {
    const result = durableController.traceContext
      ? await withRunTraceContext(durableController.traceContext, () => coordinator.executeParallel(tasks, compatibility.adapter))
      : await coordinator.executeParallel(tasks, compatibility.adapter);

    // Aggregate results
    const aggregation = aggregateTeamResults(result.results, result.totalDuration);
    const totalTokensUsed = result.results.reduce((sum, taskResult) => sum + (taskResult.tokensUsed ?? 0), 0);
    const resultByTaskId = new Map(result.results.map((taskResult) => [taskResult.taskId, taskResult]));
    const wasCancelled = Boolean(context.abortSignal?.aborted)
      || result.results.some((taskResult) => taskResult.cancelled || isCancelledTaskError(taskResult.error))
      || result.errors.some((error) => isCancelledTaskError(error.error));
    compatibility.setTerminalProjection({ cancelled: wasCancelled, result, aggregation });

    if (wasCancelled) {
      terminalStatus = 'cancelled';
      await compatibility.adapter.flushTerminals();
      return {
        success: false,
        error: `Parallel execution cancelled: ${result.errors.length} tasks did not complete.`,
        output: aggregation.agentResults.length > 0 ? aggregation.agentResults.map((entry) => {
          const taskResult = resultByTaskId.get(entry.agentId);
          const status = taskResult?.cancelled || isCancelledTaskError(taskResult?.error)
            ? 'cancelled'
            : entry.status;
          return `[${entry.role}] ${status}\n${entry.resultPreview || taskResult?.error || ''}`;
        }).join('\n\n---\n\n') : undefined,
        metadata: {
          cost: aggregation.totalCost,
          tokensUsed: totalTokensUsed,
          ...runScope,
        },
      };
    }

    terminalStatus = result.success ? 'completed' : 'failed';
    await compatibility.adapter.flushTerminals();

    // Format output for main agent (richer than before)
    const agentSummaries = aggregation.agentResults.map((entry) => {
      const filesNote = entry.filesChanged.length > 0
        ? `\nFiles: ${entry.filesChanged.join(', ')}`
        : '';
      const costNote = entry.stats.cost !== undefined
        ? ` · $${entry.stats.cost.toFixed(4)}`
        : '';
      return `[${entry.role}] ${entry.status} in ${entry.stats.durationMs}ms · ${entry.stats.iterations} iter · ${entry.stats.toolCalls ?? 'unavailable'} tool attempts${costNote}\n${entry.resultPreview}${filesNote}`;
    }).join('\n\n---\n\n');

    const filesNote = aggregation.filesChanged.length > 0
      ? `\nFiles changed (${aggregation.filesChanged.length}):\n${aggregation.filesChanged.map(f => `  ${f}`).join('\n')}`
      : '';

    const coordNote = coordSession
      ? `\n- Coordinator mode: active (${coordSession.getStats().completed}/${coordSession.getStats().total} tasks orchestrated)`
      : '';

    if (result.success) {
      return {
        success: true,
        output: `${aggregation.summary}

Stats:
- Total duration: ${result.totalDuration}ms (${aggregation.speedup.toFixed(1)}x parallel speedup)
- Max parallelism: ${result.parallelism}
- Success rate: ${(aggregation.successRate * 100).toFixed(0)}% (${result.results.filter(r => r.success).length}/${result.results.length})
- Total cost: $${aggregation.totalCost.toFixed(4)}
- Total iterations: ${aggregation.totalIterations} · Total tool attempts (terminal events, including failures/rejections): ${aggregation.unreportedToolCallAgents > 0 ? `at least ${aggregation.totalToolCalls} (${aggregation.unreportedToolCallAgents} agent(s) did not report)` : aggregation.totalToolCalls}${coordNote}
${filesNote}

Agent Results:
${agentSummaries}${coordSession ? '\n\n---\n\n' + coordSession.synthesize() : ''}`,
        metadata: {
          cost: aggregation.totalCost,
          tokensUsed: totalTokensUsed,
          ...runScope,
        },
      };
    } else {
      const failedTaskIds = new Set(result.errors.map((entry) => entry.taskId));
      const failedTasks = result.results
        .filter((taskResult) => !taskResult.success || failedTaskIds.has(taskResult.taskId))
        .map((taskResult) => {
          const task = tasks.find((candidate) => candidate.id === taskResult.taskId);
          return {
            taskId: taskResult.taskId,
            role: taskResult.role,
            task: task?.task,
            error: taskResult.error,
          };
        });
      if (failedTasks.length === 0) {
        failedTasks.push(...result.errors.map((entry) => {
          const task = tasks.find((candidate) => candidate.id === entry.taskId);
          return {
            taskId: entry.taskId,
            role: task?.role ?? entry.taskId,
            task: task?.task,
            error: entry.error,
          };
        }));
      }
      recordLongTaskRecoveryProposal(buildAgentTeamFailureRecoveryProposal({
        sessionId: context.sessionId,
        sourceMessageId: context.currentToolCallId ? `agent-team:${context.currentToolCallId}:failure` : undefined,
        totalTasks: tasks.length,
        failedTasks,
        summary: aggregation.summary,
        priorProjection: buildRecoveryPriorProjection(context.sessionId),
      }));
      return {
        success: false,
        error: `Parallel execution failed: ${result.errors.length} errors. ${aggregation.summary}`,
        output: agentSummaries + (coordSession ? '\n\n' + coordSession.synthesize() : ''),
        metadata: {
          cost: aggregation.totalCost,
          tokensUsed: totalTokensUsed,
          ...runScope,
        },
      };
    }
  } catch (error) {
    terminalStatus = context.abortSignal?.aborted ? 'cancelled' : 'failed';
    await compatibility.adapter.flushTerminals();
    return {
      success: false,
      error: `Parallel execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  } finally {
    // Cleanup event listeners
    coordinator.off('task:start', onTaskStart);
    coordinator.off('task:progress', onTaskProgress);
    coordinator.off('task:complete', onTaskComplete);
    coordinator.off('task:error', onTaskError);
    coordinator.off('discovery', onDiscovery);
    context.abortSignal?.removeEventListener('abort', onRunAbort);
    if (terminalStatus === 'cancelled') {
      await durableController.cancel('parent-cancel').catch(() => undefined);
    }
    try {
      await durableController.terminal(terminalStatus ?? 'failed', terminalStatus ? undefined : 'Agent Team exited without terminal classification');
    } finally {
      coordinatorRegistry.finalize(runScope, terminalStatus ?? 'failed');
    }
  }
}
