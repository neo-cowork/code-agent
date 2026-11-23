import Database from 'better-sqlite3';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../../src/host/services/core/database/migrations';
import { applyIndexes } from '../../../../src/host/services/core/database/indexes';
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
import { mailDraftSchema } from '../../../../src/host/tools/modules/connectors/mailDraft.schema';
import { mailSendSchema } from '../../../../src/host/tools/modules/connectors/mailSend.schema';
import { getConnectorRegistry } from '../../../../src/host/connectors';
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

export const MAIL_DRAFT_ARGS = { subject: 'Rollback plan 3', to: ['a@example.com'], content: 'Steps to roll back.' };

/** mail: the real mail_draft tool over a fake Mail connector that refuses (-1743) until green(), then saves one draft. */
export async function harness(workspace: string, file = ':memory:', sideEffect = false, calendar = false, mail = false, beforeResumedTurn?: () => Promise<void>) {
  const db = new Database(file);
  const logger = createLogger('EnvResumeFixture');
  applySchema(db, logger);
  applySessionsMigrations(db, logger);
  applyIndexes(db);
  const sessions = new SessionRepository(db);
  const events = new ToolExecutionEventRepository(db);
  const repository = new DurableRunRepository(db); repository.migrate();
  const registry = getApplicationRunRegistry(); registry.clear();
  registry.configureDurableKernel(new DurableRunKernel({ stores: repository, ownerId: 'env-host', processInstanceId: `env-process-${process.pid}`, leaseDurationMs: 120_000 }));
  const sessionId = 'env-session', runId = 'env-run', sourceId = 'env-source', toolCallId = 'env-call';
  // calendar: the real tool name, failing the way the native connector does (not_authorized), so the resolver decides to park.
  const name = mail ? 'mail_draft' : calendar ? 'calendar' : sideEffect ? 'env_fixture_write' : 'env_fixture_read';
  const protocol = getProtocolRegistry();
  let blocked = true, executions = 0, resumes = 0;
  const seenCalls: string[] = [], seenRuns: string[] = [];
  const callArgs: Record<string, unknown> = mail ? MAIL_DRAFT_ARGS : {};
  /** mail only: how the resumed model turn re-issues the draft (default: identical arguments, same run, once). */
  const reissue: { args?: Record<string, unknown>; runId?: string; twice?: boolean; tool?: string; force?: boolean; preapproveInitial?: boolean } = {};
  const schema: ToolSchema = { name, description: 'Environment recovery fixture', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'string' }, category: 'network', permissionLevel: sideEffect ? 'write' : 'read', readOnly: !sideEffect, requiresPermission: false };
  const mailConnector = {
    id: 'mail', label: 'Mail', capabilities: ['draft_message'], getStatus: async () => ({ connected: true, capabilities: [] }),
    execute: async (_action: string, payload: Record<string, unknown>) => {
      executions++; mailAttempts.push(payload.subject as string);
      if (blocked) throw Object.assign(new Error('Command failed: osascript\nexecution error: Not authorized to send Apple events to Mail. (-1743)'), { stderr: 'Not authorized to send Apple events to Mail. (-1743)' });
      saved++;
      return { data: { subject: payload.subject, to: payload.to, cc: [], bcc: [], attachments: [], saved: true } };
    },
  };
  const approvalCards: string[] = [];
  const mailAttempts: string[] = []; let saved = 0;
  // The connector tools only register on darwin; CI runs Linux, so register the real module (and connector) explicitly there.
  const registeredMailDraft = mail && !protocol.has('mail_draft');
  if (registeredMailDraft) protocol.register(mailDraftSchema, async () => (await import('../../../../src/host/tools/modules/connectors/mailDraft')).mailDraftModule);
  const registeredMailSend = mail && !protocol.has('mail_send');
  if (registeredMailSend) protocol.register(mailSendSchema, async () => (await import('../../../../src/host/tools/modules/connectors/mailSend')).mailSendModule);
  if (mail) getConnectorRegistry().register(mailConnector);
  else protocol.register(schema, async () => ({ schema, createHandler: () => ({ schema, execute: async (_args, context) => {
    executions++; seenCalls.push(context.currentToolCallId!); seenRuns.push(context.runId!);
    if (blocked && calendar) return { ok: false, error: 'Calendar not authorized', code: 'not_authorized' };
    if (blocked) throw new EnvBlockedError('perm_automation', 'mail', context.currentToolCallId!);
    return { ok: true, output: 'green tool result' };
  } }) }));
  setToolLedgerSink({
    appendToolExecutionBegin: (input) => events.appendBegin(input),
    appendToolExecutionComplete: (input) => events.appendComplete(input),
    appendPermissionDecision: (input) => out('PERMISSION_DECISION', input),
  });
  const messages = () => sessions.getMessages(sessionId);
  const persist = async (_session: string, message: Message) => { sessions.addMessage(sessionId, message); };
  const tasks = {
    getSessionState: () => ({ status: 'idle' }),
    resumeExistingDurableRun: async (_session: string, resumedId: string, history: Message[]) => {
      resumes++;
      out('MODEL_HISTORY', history);
      if (resumedId !== runId) throw new Error('run identity changed');
      sessions.updateSession(sessionId, { status: 'running' });
      const handle = registry.adoptRecoveredRun({ runId, sessionId, workspace, cwd: workspace });
      await beforeResumedTurn?.();
      if (mail) {
        // The model's next turn: it reads the recorded "not run" result and issues mail_draft again, once, through the production executor.
        sessions.addMessage(sessionId, { id: 'env-assistant-2', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [{ id: 'env-call-2', name, arguments: callArgs }] });
        const again = await executor(reissue.force).execute(reissue.tool ?? name, reissue.args ?? callArgs, { runId: reissue.runId ?? runId, sessionId, sourceMessageId: sourceId, currentToolCallId: 'env-call-2' });
        sessions.addMessage(sessionId, { id: 'env-tool-2', role: 'tool', content: '', timestamp: Date.now(), toolResults: [{ toolCallId: 'env-call-2', success: again.success, output: again.output, error: again.error }] });
        if (reissue.twice) await executor().execute(name, reissue.args ?? callArgs, { runId, sessionId, sourceMessageId: sourceId, currentToolCallId: 'env-call-3' });
      }
      await finalizeOrParkDurableRun({ registry, runId, handle, sessionId, completed: true });
      registry.unregister(runId, handle);
      sessions.updateSession(sessionId, { status: 'idle' });
    },
  } as unknown as TaskManager;
  databasePorts.current = {
    getSession: (id: string) => sessions.getSession(id),
    getMessages: () => messages(),
    getToolExecutionsBySession: (id: string) => events.getBySession(id),
    addMessage: (id: string, message: Message) => sessions.addMessage(id, message),
    appendToolExecutionComplete: (input: Parameters<typeof events.appendComplete>[0]) => events.appendComplete(input),
  };
  const executor = (forcePermissionHandler = false) => {
    const instance = new ToolExecutor({ workingDirectory: workspace, forcePermissionHandler, requestPermission: mail ? async (request) => { approvalCards.push(request.tool); return { approved: true, approvalSource: 'user' as const };  } : async () => false });
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
  return { db, registry, repository, sessions, messages, tasks, ports, continueRun, reissue,
    counts: () => ({ executions, resumes, seenCalls, seenRuns }),
    mailSaved: () => ({ attempts: mailAttempts.length, saved }),
    mailSubjects: () => [...mailAttempts],
    approvalCards: () => [...approvalCards],
    green: () => { blocked = false; },
    wire: (probe: ReturnType<EnvResumeProbeFactory>) => {
      // Exercise the production route registration; wrap only TaskManager's model sink.
      registerAgentContinueRoute({ post: () => {} } as unknown as Router, registry, () => tasks, async () => messages(), () => probe);
    },
    park: async () => {
      sessions.createSessionWithId(sessionId, { title: 'Environment fixture', modelConfig: { provider: 'openai', model: 'fixture' }, workingDirectory: workspace });
      sessions.addMessage(sessionId, { id: sourceId, role: 'user', content: 'Read the email', timestamp: 1 });
      sessions.addMessage(sessionId, { id: 'env-assistant', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: toolCallId, name, arguments: callArgs }] });
      const handle = await registry.startDurable({ runId, sessionId, workspace, cwd: workspace });
      const { ctx, engine } = makeEngine(executor().execute.bind(executor()) as never);
      Object.assign(ctx, { workingDirectory: workspace, runId, sessionId, messages: messages() });
      if (reissue.preapproveInitial) ctx.control.preApprovedTools.add('mail_draft');
      const emitted: AgentEvent[] = []; Object.assign(ctx, { onEvent: (event: AgentEvent) => { emitted.push(event); } });
      await engine.executeToolsWithHooks([{ id: toolCallId, name, arguments: callArgs }]);
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
    close: () => { registry.clear(); db.close(); if (mail) getConnectorRegistry().unregister('mail'); if (registeredMailSend) protocol.unregister('mail_send'); if (!mail || registeredMailDraft) protocol.unregister(name); },
  };
}
