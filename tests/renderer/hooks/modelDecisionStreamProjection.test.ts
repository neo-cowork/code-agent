import { describe, expect, it, vi } from 'vitest';
import type { Message, ModelDecisionEventData, ModelDecisionReason } from '../../../src/shared/contract';
import { applyConversationStreamEvent } from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

const reasons: ModelDecisionReason[] = [
  'user-selected', 'default-model', 'role-tier', 'simple-task-free', 'billing-gate-skip',
  'strategy-fast', 'strategy-main', 'strategy-deep', 'strategy-vision',
  'capability-vision', 'fallback-availability',
];
const cases = reasons.flatMap((reason) => ['model_decision', 'message'].map((type) => ({ reason, type })));

function decision(reason: ModelDecisionReason): ModelDecisionEventData {
  return {
    turnId: 'turn-1',
    requestedProvider: 'test', requestedModel: 'test-model',
    resolvedProvider: 'test', resolvedModel: 'test-model',
    role: null, billingMode: 'unknown', fallbackFrom: null, reason,
    toolStrategy: {
      visibleToolCount: 1, mcpToolCount: 0,
      programmaticToolCalling: 'available', programmaticToolCount: 1,
      tokenSavings: {
        status: 'estimated', savedTokens: 28,
        detail: '估算值：这 1 个工具的名称、说明和参数若写进普通对话上下文，约占 28 tokens；真实账单以服务商用量为准。',
      },
    },
  };
}

describe('model decision stream to trace projection', () => {
  it.each(cases)('preserves $reason from $type through the rendered node boundary', ({ reason, type }) => {
    let messages: Message[] = [
      { id: 'user-1', role: 'user', content: '请核对三份材料并总结周报风险', timestamp: 1 },
      { id: 'turn-1', role: 'assistant', content: '三份材料已核对，需先确认导出样式。', timestamp: 2 },
    ];
    const state: Parameters<typeof applyConversationStreamEvent>[1] = {
      currentTurnMessageId: 'turn-1',
      committedAssistantMessageIds: new Set(),
      lastDeltaSeqByTurn: new Map(),
      segmentRedirectByTurn: new Map(),
    };
    const actions: Parameters<typeof applyConversationStreamEvent>[2] = {
      getMessages: () => messages,
      addMessage: (message) => { messages = [...messages, message]; },
      updateMessage: (id, updates) => { messages = messages.map((m) => m.id === id ? { ...m, ...updates } : m); },
      setMessages: (next) => { messages = next; },
      queueUpdate: vi.fn(),
      now: () => 3,
    };
    const modelDecision = decision(reason);
    applyConversationStreamEvent({
      type,
      data: type === 'message'
        ? { id: 'reply-1', role: 'assistant', content: messages[1].content, modelDecision }
        : { ...modelDecision, turnId: 'turn-1' },
    }, state, actions);

    expect(messages[1].modelDecision).toEqual(modelDecision);
    const projection = projectTurns(messages, 'session-1', false);
    const node = projection.turns[0].nodes.find((n) => n.type === 'assistant_text');
    expect(node?.modelDecision).toEqual(modelDecision);
    expect(node?.modelDecision?.toolStrategy?.tokenSavings?.detail).toContain('名称、说明和参数');
  });
});
