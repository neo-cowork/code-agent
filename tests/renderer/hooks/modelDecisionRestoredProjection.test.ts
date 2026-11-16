import { describe, expect, it } from 'vitest';
import type { Message, ModelDecisionEventData } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { shouldRenderModelDecisionChip } from '../../../src/renderer/components/features/chat/RouteTraceChip';

describe('restored message with a fallback decision', () => {
  it('projects a node whose route chip renders', () => {
    const modelDecision: ModelDecisionEventData = {
      turnId: 'turn-1',
      requestedProvider: 'moonshot', requestedModel: 'kimi-k2.5',
      resolvedProvider: 'zhipu', resolvedModel: 'glm-5',
      role: null, billingMode: 'unknown',
      fallbackFrom: 'moonshot/kimi-k2.5',
      reason: 'fallback-availability',
    };
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: '总结 notes.txt', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '已总结', timestamp: 2, modelDecision },
    ];
    const node = projectTurns(messages, 'session-1', false).turns[0].nodes.find((n) => n.type === 'assistant_text');
    expect(node?.modelDecision).toEqual(modelDecision);
    expect(shouldRenderModelDecisionChip(node!.modelDecision!)).toBe(true);
  });
});
