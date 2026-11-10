import { getParallelAgentCoordinator, type AgentTask } from '../parallelAgentCoordinator';
import { createScopedSwarmAgentId, type SwarmRunScope } from '../../../shared/contract/swarm';
import { getPredefinedAgent, listPredefinedAgents, getAgentPrompt, getAgentTools, getAgentMaxIterations } from '../agentDefinition';
import { SUBAGENT_SUFFIXES, type CoreAgentId, isCoreAgent } from '../hybrid/coreAgents';
import { isToolWriteReadonlyRole } from '../routingToolPolicy';
import { SWARM_STATUS_REPORT_SUFFIX, parseStatusReport } from './statusReport';
import { isCancelledTaskError } from './parallelCancellation';
import { getSwarmEventEmitter } from '../swarmEventPublisher';
import { resolveAgentDisplayNames } from '../resolveAgentDisplayNames';
import { getSpawnGuard } from '../spawnGuard';
import { shouldUseForkMode, buildForkContexts, applyCacheControl } from '../forkContext.js';
import { createCoordinatorSession } from '../coordinatorMode';
import type { SubagentExecutionContext } from '../subagentExecutorTypes';

export function buildParallelSpawnTasks(agents: Array<{ role: string; task: string; name?: string; maxBudget?: number; dependsOn?: string[]; ownedPaths?: string[] }>, context: SubagentExecutionContext, runScope: SwarmRunScope, guard: ReturnType<typeof getSpawnGuard>)  {
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


  return { tasks, toolReadonlyRoleNames };
}

export function bindParallelSpawnVisibility(coordinator: ReturnType<typeof getParallelAgentCoordinator>, emitter: ReturnType<typeof getSwarmEventEmitter>, runScope: SwarmRunScope, tasks: AgentTask[], coordSession: ReturnType<typeof createCoordinatorSession> | undefined) : () => void {
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


  return () => {
    coordinator.off('task:start', onTaskStart);
    coordinator.off('task:progress', onTaskProgress);
    coordinator.off('task:complete', onTaskComplete);
    coordinator.off('task:error', onTaskError);
    coordinator.off('discovery', onDiscovery);
  };
}

export function prepareParallelForkCache(tasks: AgentTask[], context: SubagentExecutionContext) : void {
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



}
