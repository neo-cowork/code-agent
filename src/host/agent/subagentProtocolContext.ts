import type { ParentContext } from './childContext';
import type { SubagentExecutionContext } from './subagentExecutorTypes';
import { resolveModelDecision } from '../model/modelDecision';
import { resolveEffectivePolicy } from '../permissions/runPolicySnapshot';

export function resolveSubagentParentContext(
  context: SubagentExecutionContext,
): ParentContext {
  if (context.parentContext) return context.parentContext;
  return {
    rules: [],
    memory: [],
    hooks: [],
    skills: [],
    mcpConnections: [],
    permissionMode: resolveEffectivePolicy(context.runId, context.sessionId).mode,
    availableTools: [],
    deny: [],
    ask: [],
    allow: [],
    blockedCommands: [],
    role: context.agentRole,
  };
}

export function normalizeSubagentModelContext(
  context: SubagentExecutionContext,
  role: string,
): SubagentExecutionContext {
  const { config } = resolveModelDecision({
    requestedConfig: context.modelConfig,
    messages: [],
    context: 'subagent',
    subagentRole: role,
  });
  return { ...context, modelConfig: config };
}
