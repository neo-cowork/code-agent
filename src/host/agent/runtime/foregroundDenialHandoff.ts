// Same-turn handoff when the foreground face refuses an execution tool.
// messageProcessor stays a caller: the denial block lives here so that file does not grow.
import type { Message, ToolCall } from '../../../shared/contract';
import type { ModelResponse } from '../loopTypes';
import { extractUserRequest } from '../../../shared/utils/turnScaffold';
import { resolveAgent } from '../agentRegistry';
import { resolveToolAlias } from '../../services/toolSearch/deferredTools';
import { buildDelegatedTaskPrompt } from '../../services/commandCenter/delegationGuidance';
import { createLogger } from '../../services/infra/logger';
import { isBashToolName } from '../../tools/toolNames';
import { createToolExecutionLedger } from '../../tools/toolExecutionLedger';
import { isForegroundExcelNonReadParams } from '../../tools/runPolicyBounceText';
import type { CanUseToolFn, ToolContext } from '../../protocol/tools';
import { sealBouncedToolCalls } from './bouncedToolCallSeal';
import type { ContextAssembly } from './contextAssembly';
import { describeDeniedShellCalls } from './foregroundShellDenial';
import { isWriteBlockedDuringPlanExitFallback } from './planExitFallback';
import type { RuntimeContext } from './runtimeContext';
import { getToolAttemptTrace } from './toolAttemptTrace';
import {
  backgroundHandoffUserSentence,
  canHandOffToBackground,
  deniedToolFinalReply,
  deniedToolRetryGuidance,
  isToolDeniedForRun,
} from './toolRunPolicy';
import { resolveTurnToolFace } from './turnToolFace';
import { attachTurnQualityMetadata } from './turnQuality';

const logger = createLogger('ForegroundDenialHandoff');

/** Execution tools the foreground face drops. Excel non-read is the extra from the read-only guard. */
const HANDOFF_EXECUTION_TOOLS = new Set(['bash', 'browser', 'computer_use']);

const attemptedTurns = new WeakMap<RuntimeContext, Set<string>>();

export interface ForegroundDenialInput {
  ctx: RuntimeContext;
  contextAssembly: ContextAssembly;
  guard: { toolCallRetryCount: number };
  response: ModelResponse;
  toolCalls: ToolCall[];
  planModeActive: () => boolean;
}

function turnKey(ctx: RuntimeContext): string {
  return ctx.turn?.currentTurnId || '';
}

function alreadyAttempted(ctx: RuntimeContext): boolean {
  return attemptedTurns.get(ctx)?.has(turnKey(ctx)) === true;
}

function markAttempted(ctx: RuntimeContext): void {
  let turns = attemptedTurns.get(ctx);
  if (!turns) {
    turns = new Set();
    attemptedTurns.set(ctx, turns);
  }
  turns.add(turnKey(ctx));
}

function isRoleBoundaryDenial(ctx: RuntimeContext, toolName: string): boolean {
  const role = ctx.agentId ? resolveAgent(ctx.agentId) : undefined;
  if (!role?.tools?.length) return false;
  const face = resolveTurnToolFace({
    baseToolNames: [toolName],
    declaredToolNames: role.tools,
    turnExtraToolNames: ctx.allowedToolNames,
    roleId: role.id,
  });
  const canonical = resolveToolAlias(toolName).toLowerCase();
  return !face?.some((name) => name.toLowerCase() === canonical);
}

function isExecutionHandoffCall(ctx: RuntimeContext, call: ToolCall): boolean {
  const canonical = resolveToolAlias(call.name).toLowerCase();
  if (HANDOFF_EXECUTION_TOOLS.has(canonical)) return true;
  return isForegroundExcelNonReadParams(ctx.foregroundToolFace, call.name, call.arguments);
}

function isDeniedCall(ctx: RuntimeContext, call: ToolCall, planModeActive: () => boolean): boolean {
  return isToolDeniedForRun(ctx, call.name)
    || isForegroundExcelNonReadParams(ctx.foregroundToolFace, call.name, call.arguments)
    || isWriteBlockedDuringPlanExitFallback(ctx, planModeActive, call);
}

/**
 * Same-turn delegate only for Bash / browser / computer_use and non-read Excel.
 * Plan-exit, role boundary, unattended turns and a non-foreground face stay on the old guidance path.
 */
function isHandoffEligible(ctx: RuntimeContext, call: ToolCall, planModeActive: () => boolean): boolean {
  if (!canHandOffToBackground(ctx)) return false;
  if (isWriteBlockedDuringPlanExitFallback(ctx, planModeActive, call)) return false;
  if (isRoleBoundaryDenial(ctx, call.name)) return false;
  if (!isExecutionHandoffCall(ctx, call)) return false;
  return isDeniedCall(ctx, call, planModeActive);
}

function recordDenialTraces(ctx: RuntimeContext, toolCalls: ToolCall[], denied: ToolCall[]): void {
  for (const call of toolCalls) {
    const blocked = denied.some((item) => item.id === call.id);
    getToolAttemptTrace(ctx).begin(call);
    getToolAttemptTrace(ctx).finish(call, {
      toolCallId: call.id,
      success: false,
      error: blocked ? 'TOOL_DISABLED_FOR_RUN' : 'TOOL_BATCH_SKIPPED',
      metadata: { skipped: !blocked },
    }, false, 0);
  }
}

function verbatimUserRequest(ctx: RuntimeContext): string {
  const latest = [...(ctx.messages ?? [])].reverse().find((message) => (
    message.role === 'user' && !message.isMeta && message.visibility !== 'rewound'
  ));
  const raw = ctx.turn?.runUserPrompt || latest?.content || '';
  return extractUserRequest(raw).trim();
}

function latestUserMessageId(ctx: RuntimeContext): string | undefined {
  return [...(ctx.messages ?? [])].reverse().find((message) => (
    message.role === 'user' && !message.isMeta && message.visibility !== 'rewound'
  ))?.id;
}

const allowTool: CanUseToolFn = async () => ({ allow: true });

/**
 * The chat runtime often has no Project Source on RuntimeContext. createRunContext
 * still freezes a scope from the run cwd, and the production delegate_task call
 * reads that scope off the run-scoped executor. Use the same one.
 * A stub executor with no run context leaves the workspace empty, so
 * executeDelegateTask returns WORKSPACE_REQUIRED before it spawns.
 */
function delegationWorkspace(ctx: RuntimeContext): Pick<ToolContext, 'workspace' | 'workspaceScope'> {
  const runScope = ctx.toolExecutor.getRunContext?.()?.workspaceScope;
  const workspaceScope = ctx.workspaceScope ?? runScope;
  if (!workspaceScope) return {};
  return { workspace: workspaceScope.primaryRoot, workspaceScope };
}

async function handOffInThisTurn(ctx: RuntimeContext): Promise<boolean> {
  const userText = verbatimUserRequest(ctx);
  const turnId = turnKey(ctx);
  const title = Array.from(userText.replace(/\s+/g, '')).slice(0, 24).join('') || 'Background task';
  const stableKey = `fg-handoff:${ctx.sessionId}:${turnId}`;
  const args: Record<string, unknown> = {
    title,
    short_name: '交接',
    lane_key: stableKey,
    submission_key: stableKey,
    prompt: buildDelegatedTaskPrompt(userText, userText),
  };
  const delegatedWorkspace = delegationWorkspace(ctx);
  const toolContext: ToolContext = {
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    turnId,
    sourceMessageId: latestUserMessageId(ctx),
    workingDir: ctx.workingDirectory || delegatedWorkspace.workspace || process.cwd(),
    ...delegatedWorkspace,
    abortSignal: ctx.control.runAbortController?.signal ?? new AbortController().signal,
    logger,
    emit: (event) => ctx.onEvent(event),
    currentToolCallId: `host-handoff:${turnId}`,
    foregroundToolFace: ctx.foregroundToolFace,
    allowedToolNames: ctx.allowedToolNames,
    // 与 toolExecutionEngine 的生产调用同形：工作台收窄范围与结构化意图必须随交接下传，
    // 否则后台任务拿到无限制工具面，能调用户没选的连接器 / MCP。
    toolScope: ctx.toolScope,
    executionIntent: ctx.executionIntent,
  };
  try {
    // Dynamic: TaskManager imports AgentOrchestrator, which must not cycle back while this module loads.
    const { executeDelegateTask } = await import('../../tools/modules/commandCenter/sessionCommandCenter');
    const result = await executeDelegateTask(args, toolContext, allowTool);
    if (!result.ok) {
      logger.warn('Foreground denial handoff failed', {
        sessionId: ctx.sessionId,
        turnId,
        code: result.code,
        error: result.error,
      });
      return false;
    }
    const ledger = createToolExecutionLedger({
      toolName: 'delegate_task',
      sessionId: ctx.sessionId,
      params: args,
      startedAt: Date.now(),
      origin: 'desktop',
      workingDirectory: toolContext.workingDir,
      workspace: delegatedWorkspace.workspace || toolContext.workingDir,
      toolCallId: `host-handoff:${turnId}`,
      replaySafety: 'unknown',
    });
    ledger.begin();
    ledger.complete('success');
    logger.info('Foreground denial handed off in the same turn', { sessionId: ctx.sessionId, turnId });
    return true;
  } catch (error) {
    logger.warn('Foreground denial handoff failed', {
      sessionId: ctx.sessionId,
      turnId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function emitAssistantClose(
  ctx: RuntimeContext,
  contextAssembly: ContextAssembly,
  response: ModelResponse,
  content: string,
): Promise<void> {
  const finalMessage: Message = {
    id: contextAssembly.generateId(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
    effortLevel: ctx.turn.effortLevel,
    metadata: attachTurnQualityMetadata(ctx, undefined, response),
    ...(ctx.historyVisibility === 'meta' ? { isMeta: true } : {}),
  };
  await contextAssembly.addAndPersistMessage(finalMessage);
  ctx.onEvent({ type: 'message', data: finalMessage });
  ctx.telemetryAdapter?.onTurnEnd(ctx.turn.currentTurnId, '', response.thinking, ctx.contextHealth.currentSystemPromptHash);
  ctx.onEvent({ type: 'turn_end', data: { turnId: ctx.turn.currentTurnId } });
}

/**
 * Returns null when nothing in the batch is denied. Otherwise settles the batch:
 * a successful handoff ends the turn; a failed handoff keeps today's retry guidance.
 */
export async function settleForegroundToolDenial(input: ForegroundDenialInput): Promise<'continue' | 'break' | null> {
  const { ctx, contextAssembly, guard, response, toolCalls, planModeActive } = input;
  const deniedToolCalls = toolCalls.filter((call) => isDeniedCall(ctx, call, planModeActive));
  if (deniedToolCalls.length === 0) return null;

  recordDenialTraces(ctx, toolCalls, deniedToolCalls);
  const deniedIds = new Set(deniedToolCalls.map((call) => call.id));
  const eligible = deniedToolCalls.filter((call) => isHandoffEligible(ctx, call, planModeActive));
  if (eligible.length > 0 && !alreadyAttempted(ctx)) {
    markAttempted(ctx);
    if (await handOffInThisTurn(ctx)) {
      await sealBouncedToolCalls({ ctx, contextAssembly }, response, toolCalls, 'denied', deniedIds);
      await emitAssistantClose(ctx, contextAssembly, response, backgroundHandoffUserSentence(ctx));
      return 'break';
    }
  }

  guard.toolCallRetryCount++;
  const shellDenial = describeDeniedShellCalls(ctx, deniedToolCalls);
  contextAssembly.injectSystemMessage(
    [
      '<tool-run-policy>',
      ctx.foregroundToolFace ? 'The previous call was NOT run.'
        : `The previous call was NOT run. Internal call identifiers, not user-facing wording: ${Array.from(new Set(deniedToolCalls.filter((call) => !isBashToolName(call.name)).map((call) => call.name))).join(', ')}.`,
      deniedToolRetryGuidance(ctx),
      ...(shellDenial ? [shellDenial.guidance] : []),
      '</tool-run-policy>',
    ].join('\n'),
    'tool-policy-guard',
  );
  await sealBouncedToolCalls({ ctx, contextAssembly }, response, toolCalls, 'denied', deniedIds);
  if (guard.toolCallRetryCount > ctx.maxToolCallRetries) {
    await emitAssistantClose(ctx, contextAssembly, response, deniedToolFinalReply(ctx));
    return 'break';
  }
  return 'continue';
}
