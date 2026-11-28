import { expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { applyConversationStreamEvent } from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';

it('adds a visible background question commit without a draft to the transcript once', () => {
  const question: Message = {
    id: 'question-message',
    role: 'assistant',
    timestamp: 450,
    content: 'Cover options\n\n![Warm](warm.png) ![Cool](cool.png)',
    toolCalls: [{ id: 'question-call', name: 'AskUserQuestion', arguments: {} }],
    metadata: { correlation: { turnId: 'background-turn', traceId: 'background-run' } },
  };
  const foreground: Message = { id: 'turn-1', role: 'assistant', content: 'Foreground draft', timestamp: 300 };
  let messages = [foreground];
  const state: Parameters<typeof applyConversationStreamEvent>[1] = {
    currentTurnMessageId: 'turn-1',
    committedAssistantMessageIds: new Set(),
    lastDeltaSeqByTurn: new Map(),
    segmentRedirectByTurn: new Map(),
  };
  const actions: Parameters<typeof applyConversationStreamEvent>[2] = {
    addMessage: (message) => { messages = [...messages, message]; },
    updateMessage: (id, changes) => {
      messages = messages.map((message) => message.id === id ? { ...message, ...changes } : message);
    },
    setMessages: (next) => { messages = next; },
    getMessages: () => messages,
    queueUpdate: () => {},
    now: () => 500,
  };

  applyConversationStreamEvent({
    type: 'message', data: { ...question, isMeta: true, turnId: 'background-turn' },
  }, state, actions);
  expect(messages).toEqual([foreground]);

  applyConversationStreamEvent({ type: 'message', data: question }, state, actions);
  applyConversationStreamEvent({ type: 'message', data: question }, state, actions);
  expect(messages).toEqual([foreground, question]);
});
