import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 与 toolExecutor.observeMode.test.ts 同款 harness：resolver/cache/中间件全部换成可控
// 假件，ToolExecutor 本体走生产 execute 入口；发送路径单独把 ChannelManager 换成假件。

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/host/agent/confirmationGate', () => ({
  getConfirmationGate: () => ({
    buildPreview: () => null,
    assessRiskLevel: () => 'low',
    shouldConfirm: () => false,
  }),
}));

vi.mock('../../../src/host/security/writeIsolation', () => ({
  getWriteIsolationManager: () => ({
    acquire: vi.fn(async () => () => {}),
  }),
  getWriteIsolationScope: () => null,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const channelManagerState = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => ({
    sendMessage: channelManagerState.sendMessage,
  }),
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { enterObserveModeForCronRun } = await import('../../../src/host/cron/cronObserveMode');
const {
  bindEventReplySession,
  eventReplyPermissionRequest,
  resolveEventReplyDestination,
  EVENT_REPLY_TOOL_NAME,
} = await import('../../../src/host/tools/eventReplySession');
const { executeReplyToEvent } = await import('../../../src/host/tools/modules/cronEvent/replyToEvent');
const { withEventReplyTools } = await import('../../../src/host/tools/dispatch/toolDefinitions');
const { isExternalSideEffectTool } = await import('../../../src/host/tools/externalSideEffect');
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import type { CronEventDecisionInput, CronEventDecisionStore } from '../../../src/host/cron/cronEventDecisionLedger';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import type { ToolContext } from '../../../src/host/protocol/tools';
import type { ToolDefinition } from '../../../src/shared/contract/tool';

// ============================================================================
// N-TRIGGER-OBSERVE-ACTION-CONTRACT-DESIGN：host-owned reply_to_event。
// ① 观察档：审批/执行之前拦下，一条 would_act（可读群名 + matched_rule + 正文摘要）。
// ② 自动档：照常走审批（卡上点名目的地与正文），批准前不执行。
// ③ 目的地 host 绑定：模型参数里的账号/会话字段一律无效；event_id 只认本批事件。
// ④ 工具面：只有绑定了事件目的地的会话才注入 reply_to_event。
// ============================================================================

function channelEventJob(actionMode: 'observe' | 'auto', chatId?: string): CronJobDefinition {
  return {
    id: 'job-reply',
    name: 'group listener',
    scheduleType: 'event',
    schedule: {
      type: 'event',
      source: 'channel',
      accountId: 'acc-1',
      ...(chatId ? { chatId } : {}),
      eventName: 'message',
    },
    action: { type: 'agent', agentType: 'default', prompt: 'when someone says RR51-PING reply RR51-PONG' },
    runsOn: 'local',
    maxRunBudget: 1,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    actionMode,
  };
}

function memoryStore() {
  const rows: CronEventDecisionInput[] = [];
  const store: CronEventDecisionStore = {
    record: (batch) => { rows.push(...batch); },
    countActionsForRun: () => 0,
  };
  return { rows, store };
}

function toolContext(sessionId: string): ToolContext {
  return {
    sessionId,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    abortSignal: new AbortController().signal,
  } as unknown as ToolContext;
}

const REPLY_DEFINITION = {
  name: EVENT_REPLY_TOOL_NAME,
  description: 'reply to the inbound event',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  requiresPermission: true,
  permissionLevel: 'write' as const,
};

describe('reply_to_event (N-TRIGGER-OBSERVE-ACTION-CONTRACT-DESIGN)', () => {
  const definitions = new Map([[EVENT_REPLY_TOOL_NAME, REPLY_DEFINITION]]);

  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) => definitions.get(name));
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'sent' });
    channelManagerState.sendMessage.mockReset();
    channelManagerState.sendMessage.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    // bindEventReplySession 的解除函数在各用例 finally 里调用；这里兜底清表，
    // 防止泄漏到下一个用例（isEventReplySession 是进程级单例表）。
    vi.clearAllMocks();
  });

  it('is classified outbound (EXTERNAL): observe gate and auto-mode approval both apply', () => {
    expect(isExternalSideEffectTool(EVENT_REPLY_TOOL_NAME)).toBe(true);
  });

  it('observe mode: intercepted before approval/execution; one would_act row with readable target, matched_rule and reply summary', async () => {
    const { rows, store } = memoryStore();
    const leaveBind = bindEventReplySession('reply-observe', 'acc-1', [
      { eventId: 'om_trigger', chatId: 'oc_group', chatName: 'RR51 测试群' },
    ]);
    const leaveObserve = enterObserveModeForCronRun(channelEventJob('observe', 'oc_group'), 'reply-observe', 'run-reply-1', store, { chatName: 'RR51 测试群' });
    const requestPermission = vi.fn(async () => true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    executor.setAuditEnabled(false);
    try {
      const result = await executor.execute(EVENT_REPLY_TOOL_NAME, { text: 'RR51-PONG 收到' }, { sessionId: 'reply-observe' });
      expect(result.metadata).toMatchObject({ code: 'OBSERVE_MODE_RECORDED', executionStarted: false });
      expect(result.success).toBe(true);
      expect(resolverState.execute).not.toHaveBeenCalled();
      expect(requestPermission).not.toHaveBeenCalled();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'action',
        decision: 'would_act',
        runId: 'run-reply-1',
        tool: EVENT_REPLY_TOOL_NAME,
        // 可读目标：群名，不是 oc_ 原始 id。
        target: 'RR51 测试群',
        summary: 'RR51-PONG 收到',
      });
      expect(rows[0].matchedRule).toBeTruthy();
      expect(rows[0].matchedRule).toContain('RR51 测试群');
      expect(JSON.stringify(rows[0])).not.toContain('oc_group');
    } finally {
      leaveObserve();
      leaveBind();
    }
  });

  it('auto mode: reaches approval once (not a discovery command); the card names destination and text; denied means nothing sent', async () => {
    const leaveBind = bindEventReplySession('reply-auto', 'acc-1', [
      { eventId: 'om_trigger', chatId: 'oc_group', chatName: 'RR51 测试群' },
    ]);
    const requests: PermissionRequestData[] = [];
    const requestPermission = vi.fn(async (request: PermissionRequestData) => {
      requests.push(request);
      return { approved: false, reason: 'denied in test' } as never;
    });
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    executor.setAuditEnabled(false);
    try {
      const result = await executor.execute(EVENT_REPLY_TOOL_NAME, { text: 'RR51-PONG 收到' }, { sessionId: 'reply-auto' });
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.metadata?.code).not.toBe('OBSERVE_MODE_RECORDED');
      expect(resolverState.execute).not.toHaveBeenCalled();
      expect(channelManagerState.sendMessage).not.toHaveBeenCalled();
      // 审批卡载荷（buildPermissionRequest default 分支 → eventReplyPermissionRequest）：
      // 点名宿主绑定的目的地与回复正文。
      expect(requests[0]).toMatchObject({
        tool: EVENT_REPLY_TOOL_NAME,
        type: 'network',
      });
      expect(requests[0].details).toMatchObject({
        replyDestination: 'RR51 测试群',
        replyText: 'RR51-PONG 收到',
      });
      expect(JSON.stringify(requests[0].details)).not.toContain('oc_group');
    } finally {
      leaveBind();
    }
  });

  it('destination is host-bound: model-supplied chat/account fields never reach the send path; event_id must be one of the carried events', async () => {
    const leaveBind = bindEventReplySession('reply-bound', 'acc-1', [
      { eventId: 'om_1', chatId: 'oc_group', chatName: 'RR51 测试群' },
    ]);
    const canUseTool = vi.fn(async () => ({ allow: true })) as never;
    try {
      // 模型偷塞了一个别的会话 id（还有账号字段）：解析仍然只出自绑定表。
      const result = await executeReplyToEvent(
        { text: 'RR51-PONG 收到', chat_id: 'oc_evil', account: 'acc-evil' } as Record<string, unknown>,
        toolContext('reply-bound'),
        canUseTool,
      );
      expect(result.ok).toBe(true);
      expect(channelManagerState.sendMessage).toHaveBeenCalledTimes(1);
      const [accountId, chatId, text, options] = channelManagerState.sendMessage.mock.calls[0];
      expect(accountId).toBe('acc-1');
      expect(chatId).toBe('oc_group');
      expect(text).toBe('RR51-PONG 收到');
      // 单事件批：默认目的地回复到触发消息（replyToMessageId = 事件 id）。
      expect(options).toEqual({ replyToMessageId: 'om_1' });

      // 不在批内的 event_id：拒绝，不发送。
      channelManagerState.sendMessage.mockClear();
      const unknownEvent = await executeReplyToEvent(
        { text: 'hi', event_id: 'om_not_in_batch' } as Record<string, unknown>,
        toolContext('reply-bound'),
        canUseTool,
      );
      expect(unknownEvent.ok).toBe(false);
      expect(channelManagerState.sendMessage).not.toHaveBeenCalled();
    } finally {
      leaveBind();
    }
  });

  it('multi-chat batch without event_id is rejected; unbound sessions cannot use the tool at all', async () => {
    const leaveBind = bindEventReplySession('reply-multi', 'acc-1', [
      { eventId: 'om_1', chatId: 'oc_a' },
      { eventId: 'om_2', chatId: 'oc_b' },
    ]);
    const canUseTool = vi.fn(async () => ({ allow: true })) as never;
    try {
      const ambiguous = await resolveEventReplyDestination('reply-multi');
      expect(ambiguous.ok).toBe(false);
      const withEvent = await resolveEventReplyDestination('reply-multi', 'om_2');
      expect(withEvent).toMatchObject({ ok: true, chatId: 'oc_b' });
    } finally {
      leaveBind();
    }
    const unbound = await executeReplyToEvent({ text: 'hi' } as Record<string, unknown>, toolContext('plain-session'), canUseTool);
    expect(unbound.ok).toBe(false);
    expect(channelManagerState.sendMessage).not.toHaveBeenCalled();
  });

  it('withEventReplyTools: injected only for bound sessions; stripped from unbound sessions even in all-tools mode', () => {
    const allTools: ToolDefinition[] = [
      { ...REPLY_DEFINITION, inputSchema: REPLY_DEFINITION.inputSchema as ToolDefinition['inputSchema'], outputSchema: { type: 'string' } },
      { name: 'Read', description: 'read', inputSchema: { type: 'object' }, outputSchema: { type: 'string' }, requiresPermission: false, permissionLevel: 'read' },
    ];
    // 未绑定会话（'all' 模式全量表里混进了 reply_to_event）：剥掉。
    expect(withEventReplyTools(allTools, 'plain-session').map((tool) => tool.name)).toEqual(['Read']);
    expect(withEventReplyTools(allTools, undefined).map((tool) => tool.name)).toEqual(['Read']);
    // 绑定会话：注入（定义来自 registry 名字解析；这里只看名字集合）。
    const leaveBind = bindEventReplySession('reply-inject', 'acc-1', [{ eventId: 'om_1', chatId: 'oc_group' }]);
    try {
      const injected = withEventReplyTools(allTools.filter((tool) => tool.name !== EVENT_REPLY_TOOL_NAME), 'reply-inject');
      expect(injected.some((tool) => tool.name === EVENT_REPLY_TOOL_NAME)).toBe(true);
    } finally {
      leaveBind();
    }
  });

  it('permission request hook: only claims reply_to_event and mirrors the host-bound destination', () => {
    const leaveBind = bindEventReplySession('reply-hook', 'acc-1', [
      { eventId: 'om_1', chatId: 'oc_group', chatName: 'RR51 测试群' },
    ]);
    try {
      expect(eventReplyPermissionRequest({ name: 'mail_send', permissionLevel: 'write' }, {}, 'reply-hook')).toBeUndefined();
      const request = eventReplyPermissionRequest({ name: EVENT_REPLY_TOOL_NAME, permissionLevel: 'write' }, { text: 'pong' }, 'reply-hook');
      expect(request?.details).toMatchObject({ replyDestination: 'RR51 测试群', replyText: 'pong' });
      expect(request?.boundary?.id).toBe('channel.connector');
    } finally {
      leaveBind();
    }
  });
});
