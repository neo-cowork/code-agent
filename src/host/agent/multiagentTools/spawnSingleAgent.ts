// Single-agent execution; the public facade owns depth checks and parallel dispatch.
import { randomUUID } from 'crypto';
import {
  AgentFailureCode,
  agentFailureCodeFromCancellationReason,
  inferAgentFailureCode,
} from '../../../shared/contract/agentFailure';
import type { FullAgentConfig } from '../../../shared/contract/agentTypes';
import { routeFailureCode } from '../../../shared/contract/cancellation';
import {
  createScopedSwarmAgentId,
} from '../../../shared/contract/swarm';
import {
  getAgentMaxBudget,
  getAgentPermissionPreset,
  getAgentPrompt,
  getAgentTools,
  getPredefinedAgent,
  listPredefinedAgents,
} from '../agentDefinition';
import {
  cleanupAgentWorktree,
  cleanupOrphanedWorktrees,
  discardAgentWorktree,
  resolveAgentWorktreeIsolation,
} from '../agentWorktree';
import { forkSubagentEventPort } from '../backgroundSubagentLiveProgress';
import { checkReadonlyParentRule, type ParentContext } from '../childContext';
import { SUBAGENT_SUFFIXES, isCoreAgent, type CoreAgentId } from '../hybrid/coreAgents';
import { rememberMemberEngine } from '../memberRuntimeEngine';
import type { MultiagentExecutionResult } from '../multiagentExecutionTypes';
import { isParentRunAlive } from '../orphanLiveness';
import { isToolWriteReadonlyRole } from '../routingToolPolicy';
import { capabilityManifestForTools } from '../scriptRuntime/capabilityManifest';
import { getSpawnGuard } from '../spawnGuard';
import {
  SubagentContextBuilder,
  getAgentContextLevel,
} from '../subagentContextBuilder';
import { getSubagentExecutor } from '../subagentExecutor';
import type { SubagentExecutionContext } from '../subagentExecutorTypes';
import { resolveSubagentParentContext } from '../subagentProtocolContext';
import { resolveSpawnAgentEngine } from './spawnAgentEngine';
import { adoptForegroundSubagent, delegateSpawnAgentWorktreeCleanup, finalizeForegroundSpawnAgentWorktree, publishBackgroundSubagentVisibility, raceForegroundBlockingBudget, resolveForegroundBlockingBudgetMs, resolveSingleSpawnRunScope, validateForegroundBlockingBudget, withBackgroundWorktreeNote } from './spawnAgentForegroundBackground';
import { prepareSpawnAgentWorktree } from './spawnAgentWorktree';

export async function executeSingleSpawnAgent(
  params: Record<string, unknown>,
  context: SubagentExecutionContext,
  childDepth: number,
  treeId: string,
): Promise<MultiagentExecutionResult> {
    const guard = getSpawnGuard();
    const parallel = params.parallel as boolean | undefined;
    // Single agent mode
    const role = params.role as string;
    const task = params.task as string;
    const customPrompt = params.customPrompt as string | undefined;
    const customTools = params.customTools as string[] | undefined;
    const maxBudget = params.maxBudget as number | undefined;
    const ownedPaths = params.ownedPaths as string[] | undefined;
    const waitForCompletion = params.waitForCompletion !== false;
    const maxIterations = (params.maxIterations as number) || 20;
    const foregroundBlockingBudgetMs = resolveForegroundBlockingBudgetMs(params.foregroundBlockingBudgetMs);

    // Validate required params for single agent
    if (!task) {
      return {
        success: false,
        error: Object.keys(params).length === 0 ? 'spawn_agent 收到的 arguments 为空。请立刻重新调用并带上参数：并行起团传 parallel=true + agents 数组（每项 role+task）；单发传 role+task。' : 'Task is required. Provide role+task for predefined agent or customPrompt+task for dynamic agent.',
      };
    }

    // Determine agent mode: declarative (predefined) or dynamic
    const isDynamicMode = customPrompt && !role;
    let agentConfig: FullAgentConfig | undefined;
    let agentName: string;
    let systemPrompt: string;
    let tools: string[];

    if (isDynamicMode) {
      // Dynamic mode: use customPrompt and customTools
      agentName = 'Dynamic Agent';
      systemPrompt = customPrompt;
      tools = customTools || ['Read', 'Glob', 'Grep']; // Default read-only tools for safety
    } else {
      // Declarative mode: resolve from predefined agents
      if (!role) {
        return {
          success: false,
          error: 'Either provide role (for predefined agent) or customPrompt (for dynamic agent)',
        };
      }

      agentConfig = getPredefinedAgent(role);
      if (!agentConfig) {
        const availableIds = listPredefinedAgents().map(a => a.id);
        return {
          success: false,
          error: `Unknown agent: ${role}. Available agents: ${availableIds.join(', ')}`,
        };
      }

      agentName = agentConfig.name;
      systemPrompt = customPrompt || getAgentPrompt(agentConfig);
      tools = customTools || getAgentTools(agentConfig);
    }

    const explicitName = typeof params.name === 'string' ? params.name.trim() : '';
    const completionTitle = explicitName || task;
    if (explicitName) agentName = explicitName;

    const engineResolution = resolveSpawnAgentEngine(params.engine, parallel, !!isDynamicMode, role);
    if ('error' in engineResolution) return { success: false, error: engineResolution.error };

    // ========================================================================
    // Phase 1: Subagent suffix 注入（借鉴 Cline + Codex 行为规范）
    // ========================================================================
    if (role && isCoreAgent(role) && !customPrompt) {
      const suffix = SUBAGENT_SUFFIXES[role as CoreAgentId];
      if (suffix) {
        systemPrompt += suffix;
      }
    }

    // 根据 task 内容过滤文档工具 — 代码任务不需要文档/Excel 专用读取工具
    {
      const DOCUMENT_TOOLS = ['read_pdf', 'read_docx', 'read_xlsx', 'ReadDocument', 'ExcelAutomate'];
      const taskLower = task.toLowerCase();
      const needsDocTools = DOCUMENT_TOOLS.some(t => taskLower.includes(t.toLowerCase()))
        || /\.(pdf|docx|xlsx|doc|xls)\b/.test(taskLower);
      if (!needsDocTools) {
        tools = tools.filter(t => !DOCUMENT_TOOLS.includes(t));
      }
    }

    // ========================================================================
    // Phase 0: Subagent 上下文注入
    // ========================================================================
    // 借鉴 Claude Code: "Agents with access to current context can see the
    // full conversation history before the tool call"
    const forkContext = params.forkContext as boolean | undefined;
    try {
      // forkContext=true 时强制使用 full 上下文级别
      const contextLevel = forkContext
        ? 'full' as const
        : (role ? getAgentContextLevel(role) : 'relevant');

      // 只有在有足够上下文信息时才注入
      if (context.messages && context.messages.length > 0) {
        const contextBuilder = new SubagentContextBuilder({
          sessionId: context.sessionId || 'unknown',
          messages: context.messages,
          contextLevel,
          todos: context.todos,
          modifiedFiles: context.modifiedFiles,
        });

        const subagentContext = await contextBuilder.build(task);
        const contextPrompt = contextBuilder.formatForSystemPrompt(subagentContext);

        if (contextPrompt) {
          systemPrompt = systemPrompt + contextPrompt;
        }

        // forkContext=true 时追加 fork 前缀提示（借鉴 Codex CLI）
        if (forkContext) {
          systemPrompt += `\n\n---\n# Fork Context\nYou are a newly spawned agent. The prior conversation history was forked from your parent agent. Treat the next user message as your new task, and use the forked history only as background context.`;
        }
      }
    } catch (err) {
      // 上下文注入失败不应阻止任务执行
      console.warn('[SpawnAgent] Failed to inject subagent context:', err);
    }

    // Generate agent ID
    const localAgentId = `agent_${role || 'dynamic'}_${randomUUID()}`;
    const agentId = context.swarmRunScope
      ? createScopedSwarmAgentId(context.swarmRunScope, localAgentId)
      : localAgentId;
    rememberMemberEngine(agentId, engineResolution.engine);

    // Defensive check: ensure sessionId is available for task tool sharing
    if (!context.sessionId) {
      console.warn('[SpawnAgent] No sessionId in context — subagent task tools will use isolated session');
    }

    // ========================================================================
    // SpawnGuard: 并发检查 + 工具过滤
    // ========================================================================
    // ========================================================================
    // P3: 场景 D 兜底 — readonly 父 role 禁止 spawn writer 子 agent
    // 这是 hard topology rule，不受 inheritance 配置影响（即便用户选 independent
    // 也生效）。基于 plan §4.7 / AC-4。
    // ========================================================================
    const readonlyCheck = checkReadonlyParentRule(
      context.agentRole,
      role,
      [], // FullAgentConfig 不带 capabilities；spawnAgent 这层只用 role 做黑名单匹配
    );
    if (!readonlyCheck.allowed) {
      // swarm 护栏 P1-2 #2：readonly 父拒启 writer 子 → 结构化 child-refusal 失败码，
      // 让编排层按 routeFailureCode（'surface'）上抛而非 parse error 字符串。
      return {
        success: false,
        error: `PERMISSION_DENIED: ${readonlyCheck.reason}. Switch to default mode or spawn a non-writer agent.`,
        metadata: {
          cancellationReason: 'child-refusal',
          failureRouting: routeFailureCode('child-refusal'),
          failureCode: AgentFailureCode.BlockedByParentRole,
        },
      };
    }

    // 过滤子代理禁用工具（子不启子、不问用户等）
    // P3: 工具写只读角色额外禁用写工具（工具层面强制 readonly）。判定走单一真源
    // isToolWriteReadonlyRole：内置策展集 ∪ 自定义 agent 声明的 readonly。
    const disabledTools = isToolWriteReadonlyRole(role, agentConfig)
      ? guard.getReadonlyDisabledTools()
      : guard.getDisabledTools();
    tools = tools.filter(t => !disabledTools.includes(t));

    let slotLease: { release: () => void } | undefined;
    let registeredWithGuard = false;
    let startedExecution: Promise<unknown> | undefined;
    let worktreeInfo: { worktreePath: string; branchName: string; baseCommit: string } | undefined;
    let worktreeFinalized = false;
    let worktreeCleanupDelegated = false;
    const abortController = new AbortController();
    const parentAbortSignal = context.abortSignal;
    const abortFromParent = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(parentAbortSignal?.reason ?? 'parent-cancel');
      }
    };
    if (parentAbortSignal?.aborted) {
      abortFromParent();
    } else {
      parentAbortSignal?.addEventListener('abort', abortFromParent, { once: true });
    }
    const throwIfSpawnCancelled = (): void => {
      if (!abortController.signal.aborted) return;
      throw new Error(
        `Spawn cancelled before agent registration (${String(abortController.signal.reason ?? 'parent-cancel')})`,
      );
    };

    try {
      slotLease = await guard.acquireSlot({
        treeId,
        scope: context.swarmRunScope,
        timeoutMs: context.spawnQueueTimeoutMs,
        signal: abortController.signal,
      });
      // A slot may be handed off in the same turn that its parent run is
      // cancelled. Recheck before any executor/worktree side effect.
      throwIfSpawnCancelled();
      const executor = getSubagentExecutor();

      // Determine permission preset based on agent config
      const permissionPreset = agentConfig
        ? getAgentPermissionPreset(agentConfig)
        : 'development';

      // Determine max budget (use agent-specific or inherited)
      const effectiveMaxBudget = maxBudget || (agentConfig ? getAgentMaxBudget(agentConfig) : undefined);

      // 注入工作目录到 task，避免子 Agent 使用相对路径
      let cwd = context.cwd;

      // Best-effort orphan cleanup before creating new worktrees
      cleanupOrphanedWorktrees(cwd).catch(() => {});

      // Worktree isolation: explicit param > role-based default > none
      const effectiveIsolation = await resolveAgentWorktreeIsolation({
        tools, cwd,
        role,
        explicit: params.isolation as string | undefined,
        forceWorktree: engineResolution.engine !== 'native',
      });
      if (effectiveIsolation === 'worktree') {
        const prepared = await prepareSpawnAgentWorktree(agentId, cwd, context);
        if (!prepared.ok) { slotLease?.release(); slotLease = undefined; return prepared.failure; }
        worktreeInfo = prepared.worktreeInfo; cwd = worktreeInfo.worktreePath;
      }

      const enrichedTask = `[工作目录: ${cwd}] 所有文件路径基于此目录。\n\n${task}`;

      // Build executor context.
      // 注入 agentId，让子 agent 走 BrowserPool / ComputerSurface 的 per-agent 实例。
      // 共享 context 不能直接 mutate（父 agent 也用同一个），clone 后注入。
      const parentContext: ParentContext = context.parentContext ?? {
        ...resolveSubagentParentContext(context),
        availableTools: tools.slice(),
      };

      // 孤儿回收（swarm 护栏 P1-2 #5）：仅后台 detached 子代理注入父探活。
      // 前台子代理被父 await，不会成孤儿，跳过（多余开销）。
      // 动态 import 取 TaskManager，避开 task→agent 的静态循环依赖。
      let isParentAlive: (() => boolean) | undefined;
      if (!waitForCompletion && context.sessionId) {
        try {
          const { getTaskManager } = await import('../../task/TaskManager');
          const tm = getTaskManager();
          const parentSessionId = context.sessionId;
          const parentState = tm.getSessionState(parentSessionId);
          // 只在父确实处于活跃 run 时装探活；否则无法判定父子归属，保守不杀
          if (parentState.status === 'running' || parentState.status === 'paused') {
            const parentStartTime = parentState.startTime;
            isParentAlive = () =>
              isParentRunAlive(tm.getSessionState(parentSessionId), parentStartTime);
          }
        } catch {
          // TaskManager 不可用（测试 / CLI / 无 run 上下文）→ 不装探活
        }
      }

      const childEvents = forkSubagentEventPort(context.events, !waitForCompletion);
      const executorContext: SubagentExecutionContext = {
        ...context, cwd,
        events: childEvents,
        // swarm 护栏 P1-2 #2：把递增后的深度沿 execution context 传递
        agentId,
        ownedPaths,
        spawnDepth: childDepth,
        spawnMaxDepth: context.spawnMaxDepth,
        spawnTreeId: treeId,
        swarmRunScope: context.swarmRunScope,
        spawnQueueTimeoutMs: context.spawnQueueTimeoutMs,
        spawnParentStartedAt: context.spawnParentStartedAt,
        spawnParentTimeoutMs: context.spawnParentTimeoutMs,
        parentRemainingBudget: context.parentRemainingBudget,
        spawnParentAgentId: context.spawnParentAgentId,
        parentToolUseId: context.currentToolCallId,
        abortSignal: abortController.signal,
        spawnGuardId: agentId,
        executionAgentId: agentId,
        worktreePath: worktreeInfo?.worktreePath,
        capabilityManifest: capabilityManifestForTools(tools),
        hooks: context.hooks,
        parentContext,
        // 后台 detached 子代理的父探活（仅 !waitForCompletion 时非 undefined）
        isParentAlive,
      };

      const executorConfig = {
        name: agentName,
        engine: engineResolution.engine,
        // 持久化角色资产绑定 key（roles/<roleId>/）。declarative 模式下 role 即 agent 注册 id；
        // dynamic 模式没有 role，不参与角色资产链路。
        roleId: role || undefined,
        systemPrompt,
        availableTools: tools,
        // GAP-011：声明式 agent 定义里的预装 skills 透传给 executor（方向 A）
        skills: agentConfig?.skills,
        maxIterations,
        permissionPreset,
        maxBudget: effectiveMaxBudget,
      };
      const budgetError = validateForegroundBlockingBudget(agentName, foregroundBlockingBudgetMs);
      if (budgetError) return budgetError;

      let settleWorktreeNote: (note: string) => void = () => {};
      const worktreeNoteSettled = new Promise<string>((resolve) => { settleWorktreeNote = resolve; });
      const delegateWorktreeCleanup = (): void => {
        if (!worktreeInfo || worktreeCleanupDelegated || worktreeFinalized) return;
        delegateSpawnAgentWorktreeCleanup({ guard, agentId, repoPath: context.cwd, worktreeInfo, isFinalized: () => worktreeFinalized, markFinalized: () => { worktreeFinalized = true; }, onSettled: settleWorktreeNote });
        worktreeCleanupDelegated = true;
      };

      // Covers cancellation during async worktree/context preparation. Once
      // this check passes, execute()+register() run in one synchronous turn.
      throwIfSpawnCancelled();

      if (waitForCompletion) {
        // Execute and wait for result
        const agentStartedAt = Date.now();
        const promise = executor.execute({
          prompt: enrichedTask,
          config: executorConfig,
          context: executorContext,
        });
        startedExecution = promise;

        // Register with SpawnGuard
        guard.register(agentId, role || 'dynamic', task, promise, abortController, {
          treeId,
          completion: { title: completionTitle, kind: 'user_visible' },
          parentId: context.spawnParentAgentId,
          slotAcquired: true,
          scope: context.swarmRunScope,
        });
        registeredWithGuard = true;
        slotLease = undefined;

        const raced = await raceForegroundBlockingBudget(promise, foregroundBlockingBudgetMs);

        if (raced.kind === 'timeout') {
          delegateWorktreeCleanup();
          // The adopted task outlives this tool call; keep the parent signal
          // listener from cancelling it when the engine settles the tool.
          // 行为变化（相对基线）：被收养的子代理不再跟随整轮停止而取消，
          // 与 run_in_background 的 detached 语义一致，取消走 close_agent。
          parentAbortSignal?.removeEventListener('abort', abortFromParent);
          return adoptForegroundSubagent({
            promise: worktreeInfo ? withBackgroundWorktreeNote(promise, worktreeNoteSettled, agentId) : promise,
            agentId,
            agentName,
            completionTitle,
            role,
            context,
            treeId,
            task,
            agentStartedAt,
            foregroundBlockingBudgetMs,
            childEvents,
          });
        }

        const result = raced.result;

        // Worktree cleanup: check for changes and cleanup or preserve
        const finalizedWorktree = await finalizeForegroundSpawnAgentWorktree({
          agentId,
          repoPath: context.cwd,
          worktreeInfo,
          result,
          aborted: abortController.signal.aborted,
        });
        worktreeFinalized = worktreeFinalized || finalizedWorktree.finalized;
        const worktreeNote = finalizedWorktree.worktreeNote;

        if (result.success) {
          // N-SUBAGENT-ZEROTOOLS：部分声明的工具没装配上时清单带回父模型（能力可能不完整，
          // 让父模型自行裁量结果可信度），不静默吞掉。
          const missingToolsNote = result.missingTools?.length
            ? `\n- Missing tools: ${result.missingTools.join(', ')}（声明的工具未全部装配，该子代理能力可能不完整）`
            : '';
          return {
            success: true,
            // Background completion notifications carry the task result, without role/tool/id wrappers.
            output: params.run_in_background === true ? `${result.output}${worktreeNote}` : `Agent [${agentName}] completed task:

Task: ${task}

Result:
${result.output}

Stats:
- Iterations: ${result.iterations}
- Tools used: ${result.toolsUsed.join(', ') || 'none'}
- Agent ID: ${agentId}
- Pipeline ID: ${result.agentId || 'N/A'}${result.cost !== undefined ? `\n- Cost: $${result.cost.toFixed(4)}` : ''}${missingToolsNote}${worktreeNote}`,
            metadata: {
              agentId,
              cost: result.cost,
              tokensUsed: result.tokensUsed,
              ...(result.missingTools?.length ? { missingTools: result.missingTools } : {}),
              ...(context.swarmRunScope ?? {}),
            },
          };
        } else {
          return {
            success: false,
            error: params.run_in_background === true
              ? `${result.error}${worktreeNote}`
              : `Agent [${agentName}] failed: ${result.error}${worktreeNote}`,
            output: result.output,
            metadata: {
              agentId,
              cost: result.cost,
              tokensUsed: result.tokensUsed,
              ...(result.missingTools?.length ? { missingTools: result.missingTools } : {}),
              ...(context.swarmRunScope ?? {}),
              cancellationReason: result.cancellationReason,
              failureCode: result.failureCode
                ?? agentFailureCodeFromCancellationReason(result.cancellationReason)
                ?? inferAgentFailureCode({ error: result.error }),
            },
          };
        }
      } else {
        // Start agent in background
        const promise = executor.execute({
          prompt: enrichedTask,
          config: executorConfig,
          context: {
            ...executorContext,
            // 后台 detached 子 agent 标 async_agent（2026-07-13 拍板）；调用方已显式标注时尊重之
            executionTopology: executorContext.executionTopology ?? 'async_agent',
          },
        });
        startedExecution = promise;

        // Register with SpawnGuard (auto-tracks completion)
        guard.register(agentId, role || 'dynamic', task, promise, abortController, {
          treeId,
          completion: { title: completionTitle, kind: 'user_visible' },
          parentId: context.spawnParentAgentId,
          slotAcquired: true,
          scope: context.swarmRunScope,
        });
        registeredWithGuard = true;
        slotLease = undefined;

        const visibilityScope = resolveSingleSpawnRunScope(context, treeId, agentId);
        publishBackgroundSubagentVisibility({
          promise,
          scope: visibilityScope,
          agentId,
          agentName,
          role: role || 'dynamic',
          task,
          startedAt: Date.now(),
          ownsRunLifecycle: !context.swarmRunScope,
        });

        // Background worktree cleanup: register onComplete callback
        delegateWorktreeCleanup();

        // 后台子代理的生命周期交给 SpawnGuard / close_agent：工具调用收口时引擎会
        // abort 本次调用的信号，不摘除监听会把已报告「后台运行中」的子代理连带取消。
        // 代价是不再跟随整轮停止而取消（基线行为），与 run_in_background / 前台超时
        // 收养的 detached 语义一致。
        parentAbortSignal?.removeEventListener('abort', abortFromParent);

        const isolationNote = worktreeInfo
          ? `\n- Isolation: worktree (branch: ${worktreeInfo.branchName}, path: ${worktreeInfo.worktreePath})`
          : '';

        return {
          success: true,
          output: `Agent [${agentName}] spawned in background:
- Agent ID: ${agentId}
- Task: ${task}
- Status: running
- Mode: ${isDynamicMode ? 'dynamic' : 'declarative'}
- Running agents: ${guard.getRunningCount(
          context.swarmRunScope ?? (context.sessionId ? { sessionId: context.sessionId } : undefined),
        )}${isolationNote}

Use wait_agent to block until done, or close_agent to cancel.`,
        };
      }
    } catch (error) {
      if (!registeredWithGuard) {
        if (startedExecution) {
          abortController.abort('registration-failed');
          await startedExecution.catch(() => undefined);
        }
        slotLease?.release();
      }
      if (worktreeInfo && !worktreeFinalized && !worktreeCleanupDelegated) {
        const repoPath = context.cwd;
        if (abortController.signal.aborted) {
          await discardAgentWorktree(agentId, worktreeInfo.worktreePath, repoPath).catch(() => {});
        } else {
          await cleanupAgentWorktree(agentId, worktreeInfo.worktreePath, repoPath, worktreeInfo.baseCommit).catch(() => {});
        }
      }
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `Failed to spawn agent: ${errorMsg}`,
        metadata: {
          failureCode: inferAgentFailureCode({ error: errorMsg, defaultCode: AgentFailureCode.ModelError }),
        },
      };
    }
}
