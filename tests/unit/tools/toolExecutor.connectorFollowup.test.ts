import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { getDeferredToolsToPreloadForTurn } from '../../../src/host/agent/runtime/contextAssembly/deferredToolPreload';
import { getTextForegroundToolNamesForPrompt } from '../../../src/host/app/sessionCommandCenterBrain';
import { calendarConnector } from '../../../src/host/connectors/native/calendar';
import { mailConnector } from '../../../src/host/connectors/native/mail';
import { remindersConnector } from '../../../src/host/connectors/native/reminders';
import { getConnectorRegistry } from '../../../src/host/connectors/registry';
import { createLogger } from '../../../src/host/services/infra/logger';
import { getConfigService } from '../../../src/host/services/core/configService';
import { getDenialRegistry } from '../../../src/host/security/denialRegistry';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { AgentEvent, Message, ToolCall } from '../../../src/shared/contract';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({ generateBashDescription: async () => null }));

const FIRST = 'Add a team sync to my calendar tomorrow at 3pm for 30 minutes.';
const FOLLOWUP = 'No wait, make it Nov 17 at 15:00 and create it';

// Real admission entry + real connector registry + real executor and permission island.
// Only persistence/telemetry and the post-admission engine dispatch are local ports;
// the adapter dispatches to ToolExecutor.execute, never recreates an admission rule.
describe('connector follow-up through MessageProcessor.handleToolResponse', () => {
  // The connector tools are registered on macOS only; pin the platform so the suite is host-independent
  // (Linux CI otherwise answers "Unknown tool" before any approval is asked).
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }); });
  afterAll(() => { Object.defineProperty(process, 'platform', realPlatform); });
  let messages: Message[];
  let events: AgentEvent[];
  let executor: ToolExecutor;
  let seq: number;

  beforeEach(() => {
    messages = [];
    events = [];
    seq = 0;
    getDenialRegistry().clearAll();
    resetPermissionModeManager();
    resetPolicyEngine();
    const settings = getConfigService().getSettings();
    vi.spyOn(getConfigService(), 'getSettings').mockReturnValue({ ...settings, connectors: { enabledNative: ['calendar', 'mail', 'reminders'] } });
    getConnectorRegistry().configure([]);
    for (const connector of [calendarConnector, mailConnector, remindersConnector]) {
      getConnectorRegistry().register(connector);
      vi.spyOn(connector, 'getCachedStatus').mockReturnValue({ connected: true, readiness: 'ready', capabilities: [] });
    }
    const island = new OrchestratorPermissionIsland({
      getSettings: () => ({ ...settings, permissions: { ...settings.permissions,
        autoApprove: { read: false, write: false, execute: false, network: false } } }),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => true,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'permission_request' && !event.data.resolved) {
          queueMicrotask(() => island.handlePermissionResponse(event.data.id, 'deny'));
        }
      },
    });
    executor = new ToolExecutor({ workingDirectory: process.cwd(), requestPermission: (request) => island.requestPermission(request) });
    executor.setAuditEnabled(false);
  });
  afterEach(() => {
    getDenialRegistry().clearAll();
    resetPermissionModeManager();
    resetPolicyEngine();
    vi.restoreAllMocks();
    getConnectorRegistry().configure([]);
  });

  function user(content: string) {
    const prior = [...messages];
    messages.push({ id: `user-${++seq}`, role: 'user', content, timestamp: seq });
    const turn = TurnState.forTest({ currentTurnId: `turn-${seq}` });
    turn.beginRun(content);
    const ctx = {
      sessionId: 'connector-followup', runId: `run-${seq}`, workingDirectory: process.cwd(), messages,
      allowedToolNames: getTextForegroundToolNamesForPrompt(content, undefined, undefined, prior),
      foregroundToolFace: true, enableToolDeferredLoading: true, enableHooks: false,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
      maxToolCallRetries: 3, artifact: ArtifactState.forTest(), control: ControlState.forTest(),
      turn,
      stats: RunStatsState.forTest(), contextHealth: ContextHealthState.forTest(), turnQualityState: {},
      nudgeManager: { checkProgressState: vi.fn() }, onEvent: (event: AgentEvent) => events.push(event),
    } as unknown as RuntimeContext;
    const assembly = {
      generateId: () => `message-${++seq}`, stripInternalFormatMimicry: (text: string) => text,
      addAndPersistMessage: async (message: Message) => { messages.push(message); },
      injectSystemMessage: vi.fn(), flushHookMessageBuffer: vi.fn(), updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(), maybeInjectThinking: vi.fn(),
    } as unknown as ContextAssembly;
    const dispatch = vi.fn(async (calls: ToolCall[]) => Promise.all(calls.map(async (call) => ({
      toolCallId: call.id, ...await executor.execute(call.name, call.arguments, {
        sessionId: ctx.sessionId, runId: ctx.runId, sourceMessageId: messages.findLast((message) => message.role === 'user')?.id,
        allowedToolNames: ctx.allowedToolNames, currentToolCallId: call.id,
      }),
    }))));
    const processor = new MessageProcessor(ctx, assembly, {
      tryParseTodosFromResponse: vi.fn(), autoAdvanceTodos: vi.fn(), emitTaskProgress: vi.fn(), emitTaskComplete: vi.fn(),
    } as unknown as RunFinalizer, { executeToolsWithHooks: dispatch } as unknown as ToolExecutionEngine);
    const call = async (name = 'calendar_create_event', start = 1794956400000) => {
      await processor.handleToolResponse({ type: 'tool_use', toolCalls: [{
        id: `call-${++seq}`, name, arguments: { title: 'Team sync', start_ms: start, end_ms: start + 1800000 },
      }] }, false, 1, { endSpan: vi.fn() });
      return messages.at(-1)?.toolResults?.[0];
    };
    return { ctx, call, dispatch };
  }
  const cards = () => events.filter((event) => event.type === 'permission_request' && !event.data.resolved);

  it('denied calendar ask then referential new message reaches a NEW permission_request', async () => {
    const first = user(FIRST);
    await first.call();
    expect(cards()).toHaveLength(1);
    const second = user(FOLLOWUP);
    const result = await second.call();
    expect(result?.metadata?.code).not.toBe('TOOL_DISABLED_FOR_RUN');
    expect(second.dispatch).toHaveBeenCalledOnce();
    expect(cards()).toHaveLength(2);
    expect(getDeferredToolsToPreloadForTurn(second.ctx)).toContain('calendar_create_event');
    expect(new Set(cards().map((event) => event.type === 'permission_request' ? event.data.id : '')).size).toBe(2);
  });

  it('same-message changed arguments remain sticky with zero new cards', async () => {
    const first = user(FIRST);
    await first.call();
    const warn = vi.spyOn(Object.getPrototypeOf(createLogger('DenialRegistry')) as ReturnType<typeof createLogger>, 'warn');
    const retry = await first.call('calendar_create_event', 1794960000000);
    expect(cards()).toHaveLength(1);
    expect(retry?.metadata?.hostReason).toMatchObject({ code: 'PERMISSION_DENIED_BY_USER' });
    expect(retry?.error).toContain('The user just declined this kind of action');
    expect(warn).toHaveBeenCalledWith('user-denied-goal-sticky: refusing approval before ask/park', expect.objectContaining({ toolFamily: 'calendar_create_event', scope: 'message:user-1', reason: 'same-tool' }));
    process.stdout.write(`calendar same-message refusal: ${JSON.stringify(warn.mock.calls.find(([name]) => name.startsWith('user-denied-goal-sticky')))}\n`);
  });

  it.each([
    ['Send an email to pat@example.test about the sync.', 'No wait, send it to sam@example.test instead.', 'mail_send'],
    ['Add a reminder to call Pat tomorrow.', 'Please move it to Friday.', 'reminders_create'],
    [FIRST, '改到11月17日下午三点，重新创建', 'calendar_create_event'],
  ])('both consumers carry a unique connector: %s', (prior, followup, tool) => {
    user(prior);
    const next = user(followup);
    expect(next.ctx.allowedToolNames).toContain(tool);
    expect(getDeferredToolsToPreloadForTurn(next.ctx)).toContain(tool);
  });

  it('scope/readiness restrictions and non-foreground runs still exclude inherited tools', () => {
    user(FIRST);
    const next = user(FOLLOWUP);
    expect(getTextForegroundToolNamesForPrompt(FOLLOWUP, ['mail'], undefined, messages.slice(0, -1)))
      .not.toContain('calendar_create_event');
    expect(getDeferredToolsToPreloadForTurn({ ...next.ctx, foregroundToolFace: false, allowedToolNames: undefined }))
      .not.toContain('calendar_create_event');
    expect(getDeferredToolsToPreloadForTurn({ ...next.ctx, unattendedTurn: true, allowedToolNames: undefined }))
      .not.toContain('calendar_create_event');
    const connector = getConnectorRegistry().get('calendar')!;
    vi.spyOn(connector, 'getCachedStatus').mockReturnValue({ ...connector.getCachedStatus!(), readiness: 'failed' });
    expect(getTextForegroundToolNamesForPrompt(FOLLOWUP, undefined, undefined, messages.slice(0, -1)))
      .not.toContain('calendar_create_event');
  });

  it('topic changes, ambiguity, hidden and cross-session history never carry a connector', () => {
    user(FIRST);
    user('Explain how rainbows form.');
    expect(user(FOLLOWUP).ctx.allowedToolNames).not.toContain('calendar_create_event');
    expect(getTextForegroundToolNamesForPrompt(FOLLOWUP)).not.toContain('calendar_create_event');
    for (const history of [
      [{ role: 'user' as const, content: 'Send mail and add a calendar event.' }],
      [{ role: 'user' as const, content: FIRST, isMeta: true }],
      [{ role: 'user' as const, content: FIRST, visibility: 'rewound' as const }],
    ]) {
      expect(getTextForegroundToolNamesForPrompt(FOLLOWUP, undefined, undefined, history)).not.toContain('calendar_create_event');
    }
    expect(getTextForegroundToolNamesForPrompt('No wait, make it a spreadsheet.', undefined, undefined,
      [{ role: 'user', content: FIRST }])).not.toContain('calendar_create_event');
  });

  it('an explicit tool deny still wins over inherited connector intent', async () => {
    await user(FIRST).call();
    const next = user(FOLLOWUP);
    getPolicyEngine().loadUserRules({ deny: ['calendar_create_event'] }, 'user-ui');
    const result = await next.call();
    expect(cards()).toHaveLength(1);
    expect(result?.success).toBe(false);
    expect(result?.metadata?.hostReason).toMatchObject({ code: 'PERMISSION_DENIED_USER_RULE' });
  });

  it('an unrelated new message does not inherit calendar admission', async () => {
    await user(FIRST).call();
    const other = user('Explain how rainbows form.');
    expect(getDeferredToolsToPreloadForTurn(other.ctx)).not.toContain('calendar_create_event');
    const result = await other.call();
    expect(result?.metadata?.code).toBe('TOOL_DISABLED_FOR_RUN');
    expect(other.dispatch).not.toHaveBeenCalled();
    expect(cards()).toHaveLength(1);
  });

  it.each([
    'Okay, make it Nov 17 at 15:00',
    '把时间改成17号下午3点',
    'No, Nov 17 at 3pm please',
    'Make the meeting Nov 17 at 15:00 instead',
    '17号下午三点吧，帮我建上',
  ])('ordinary correction %j after a decline reaches a NEW permission_request', async (correction) => {
    await user(FIRST).call();
    expect(cards()).toHaveLength(1);
    const second = user(correction);
    const result = await second.call();
    expect(result?.metadata?.code).not.toBe('TOOL_DISABLED_FOR_RUN');
    expect(second.dispatch).toHaveBeenCalledOnce();
    expect(cards()).toHaveLength(2);
  });

  it.each([
    'What is the weather like in Beijing?',
    '今天北京天气怎么样',
    'Write a sorting function for me',
    'Explain how rainbows form.',
  ])('unrelated new topic %j after a decline stays bounced with zero new cards', async (other) => {
    await user(FIRST).call();
    const next = user(other);
    const result = await next.call();
    expect(result?.metadata?.code).toBe('TOOL_DISABLED_FOR_RUN');
    expect(next.dispatch).not.toHaveBeenCalled();
    expect(cards()).toHaveLength(1);
  });
});
