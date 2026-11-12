import Database from 'better-sqlite3';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { SessionRepository } from '../../../../src/host/services/core/repositories/SessionRepository';
import { ToolExecutionEventRepository } from '../../../../src/host/services/core/repositories/ToolExecutionEventRepository';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { getApplicationRunRegistry } from '../../../../src/host/app/applicationRunRegistry';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { createApplicationNativeRecoveryPorts } from '../../../../src/host/app/nativeRecoveryHost';
import { continueParkedDurableRun } from '../../../../src/host/app/durableRunContinuation';
import { finalizeOrParkDurableRun } from '../../../../src/host/agent/orchestrator/durableRunTerminal';
import { EnvBlockedError } from '../../../../src/host/permissions/envAssist/EnvBlockedError';
import { getProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';
import { getToolDefinitionWithCloudMeta } from '../../../../src/host/tools/dispatch/toolDefinitions';
import { setToolLedgerSink } from '../../../../src/host/tools/toolLedgerSink';
import { ToolExecutor } from '../../../../src/host/tools/toolExecutor';
import { registerAgentContinueRoute } from '../../../../src/web/routes/registerAgentContinueRoute';
import { makeEngine } from './envResumeContext';
import { createLogger } from '../../../../src/host/services/infra/logger';
import type { ToolSchema } from '../../../../src/host/protocol/tools';
import type { Message, AgentEvent } from '../../../../src/shared/contract';
import type { TaskManager } from '../../../../src/host/task';
import type { Router } from 'express';
import type { EnvResumeProbeFactory } from '../../../../src/host/runtime/envResumeWaiter';

const out = (label: string, value: unknown) => process.stdout.write(`${label} ${JSON.stringify(value)}\n`);

export const databasePorts: { current: Record<string, unknown> } = { current: {} };

export async function harness(workspace: string, file = ':memory:', sideEffect = false) {
  const db = new Database(file);
  applySchema(db, createLogger('EnvResumeFixture'));
  const sessions = new SessionRepository(db);
  const events = new ToolExecutionEventRepository(db);
  const repository = new DurableRunRepository(db); repository.migrate();
  const registry = getApplicationRunRegistry(); registry.clear();
  registry.configureDurableKernel(new DurableRunKernel({ stores: repository, ownerId: 'env-host', processInstanceId: `env-process-${process.pid}`, leaseDurationMs: 120_000 }));
  const sessionId = 'env-session', runId = 'env-run', sourceId = 'env-source', toolCallId = 'env-call';
  const name = sideEffect ? 'env_fixture_write' : 'env_fixture_read';
  const protocol = getProtocolRegistry();
  let blocked = true, executions = 0, resumes = 0;
  const seenCalls: string[] = [], seenRuns: string[] = [];
  const schema: ToolSchema = { name, description: 'Environment recovery fixture', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'string' }, category: 'network', permissionLevel: sideEffect ? 'write' : 'read', readOnly: !sideEffect, requiresPermission: false };
  protocol.register(schema, async () => ({ schema, createHandler: () => ({ schema, execute: async (_args, context) => {
    executions++; seenCalls.push(context.currentToolCallId!); seenRuns.push(context.runId!);
    if (blocked) throw new EnvBlockedError('perm_automation', 'mail', context.currentToolCallId!);
    return { ok: true, output: 'green tool result' };
  } }) }));
  setToolLedgerSink({
    appendToolExecutionBegin: (input) => events.appendBegin(input),
    appendToolExecutionComplete: (input) => events.appendComplete(input),
    appendPermissionDecision: () => {},
  });
  const messages = () => sessions.getMessages(sessionId);
  const persist = async (_session: string, message: Message) => { sessions.addMessage(sessionId, message); };
  const tasks = {
    getSessionState: () => ({ status: 'idle' }),
    resumeExistingDurableRun: async (_session: string, resumedId: string, history: Message[]) => {
      resumes++;
      out('MODEL_HISTORY', history);
      if (resumedId !== runId) throw new Error('run identity changed');
      const handle = registry.adoptRecoveredRun({ runId, sessionId, workspace, cwd: workspace });
      await finalizeOrParkDurableRun({ registry, runId, handle, sessionId, completed: true });
      registry.unregister(runId, handle);
    },
  } as unknown as TaskManager;
  databasePorts.current = {
    getSession: (id: string) => sessions.getSession(id),
    getMessages: () => messages(),
    getToolExecutionsBySession: (id: string) => events.getBySession(id),
    addMessage: (id: string, message: Message) => sessions.addMessage(id, message),
    appendToolExecutionComplete: (input: Parameters<typeof events.appendComplete>[0]) => events.appendComplete(input),
  };
  const executor = () => {
    const instance = new ToolExecutor({ workingDirectory: workspace, requestPermission: async () => false });
    instance.setAuditEnabled(false); return instance;
  };
  const ports = createApplicationNativeRecoveryPorts(registry, {
    sessions: { getMessages: async () => messages(), updateMessage: async () => {} }, tasks,
    persistToolMessage: persist, resolveToolDefinition: getToolDefinitionWithCloudMeta,
    toolExecutions: (id) => events.getBySession(id),
    storedToolReplaySafety: (_id, executionId) => events.getBySession(sessionId).find((event) => event.executionId === executionId && event.phase === 'begin')?.replaySafety ?? null,
    acknowledgeToolRecovery: (_id, executionId, toolName) => { if (executionId) events.appendComplete({ executionId, sessionId, toolName, status: 'recovered', recordedAt: Date.now() }); },
    executeTool: async (input) => {
      const plan = await registry.getDurableRehydrationPlan(runId);
      const handle = registry.bindRecoveredHandle(plan, workspace);
      try { return await executor().execute(input.name, input.arguments, { runId, sessionId, sourceMessageId: sourceId, currentToolCallId: input.toolCallId }); }
      finally { registry.unregister(runId, handle); }
    },
  });
  const continueRun = () => continueParkedDurableRun({ sessionId, runRegistry: registry, taskManager: tasks, getMessages: async () => messages(), envRecoveryPorts: ports });
  return { db, registry, repository, messages, tasks, ports, continueRun,
    counts: () => ({ executions, resumes, seenCalls, seenRuns }),
    green: () => { blocked = false; },
    wire: (probe: ReturnType<EnvResumeProbeFactory>) => {
      // Exercise the production route registration; wrap only TaskManager's model sink.
      registerAgentContinueRoute({ post: () => {} } as unknown as Router, registry, () => tasks, async () => messages(), () => probe);
    },
    park: async () => {
      sessions.createSessionWithId(sessionId, { title: 'Environment fixture', modelConfig: { provider: 'openai', model: 'fixture' }, workingDirectory: workspace });
      sessions.addMessage(sessionId, { id: sourceId, role: 'user', content: 'Read the email', timestamp: 1 });
      sessions.addMessage(sessionId, { id: 'env-assistant', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: toolCallId, name, arguments: {} }] });
      const handle = await registry.startDurable({ runId, sessionId, workspace, cwd: workspace });
      const { ctx, engine } = makeEngine(executor().execute.bind(executor()) as never);
      Object.assign(ctx, { workingDirectory: workspace, runId, sessionId, messages: messages() });
      const emitted: AgentEvent[] = []; Object.assign(ctx, { onEvent: (event: AgentEvent) => { emitted.push(event); } });
      await engine.executeToolsWithHooks([{ id: toolCallId, name, arguments: {} }]);
      if (!ctx.control.isCancelled) throw new Error(`Engine did not cancel: ${JSON.stringify(emitted)}`);
      await finalizeOrParkDurableRun({ registry, runId, handle, sessionId, completed: false, cancelled: ctx.control.isCancelled });
      out('PARK_ENVELOPE', db.prepare('SELECT envelope_json FROM durable_runs').all());
      out('PARK_EVENT', db.prepare("SELECT event_type,event_json FROM durable_run_events WHERE event_type='run_interrupted'").all());
      return { ctx, emitted };
    },
    dump: () => {
      out('MESSAGES', db.prepare('SELECT id,role,content,tool_calls,tool_results FROM messages ORDER BY timestamp').all());
      out('TOOL_EVENTS', db.prepare('SELECT * FROM tool_execution_events').all());
      out('COUNTS', { executions, resumes, seenCalls, seenRuns });
    },
    close: () => { registry.clear(); db.close(); protocol.unregister(name); },
  };
}
