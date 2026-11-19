import { describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { ModelDecisionEventData } from '../../../src/shared/contract';
import { getFallbackDuplicateChipNodeIds } from '../../../src/renderer/utils/fallbackChipDedup';

const decision = (o: Partial<ModelDecisionEventData>) => ({
  reason: 'user-selected', requestedModel: 'a', resolvedModel: 'a', fallbackFrom: null, ...o,
}) as ModelDecisionEventData;
const text = (id: string, d?: ModelDecisionEventData): TraceNode => ({ id, type: 'assistant_text', content: 'x', timestamp: 1, modelDecision: d });
const banner: TraceNode = { id: 'b', type: 'system', content: '{}', timestamp: 1, subtype: 'model_fallback' };

describe('getFallbackDuplicateChipNodeIds', () => {
  it('hides fallbackFrom chip when the turn has a banner', () => {
    expect([...getFallbackDuplicateChipNodeIds([text('a', decision({ fallbackFrom: 'x/y' })), banner])]).toEqual(['a']);
  });
  it('hides fallback-availability chip even without fallbackFrom', () => {
    expect(getFallbackDuplicateChipNodeIds([banner, text('a', decision({ reason: 'fallback-availability', resolvedModel: 'b' }))]).has('a')).toBe(true);
  });
  it('keeps the chip when there is no banner (no-API-key case)', () => {
    expect(getFallbackDuplicateChipNodeIds([text('a', decision({ fallbackFrom: 'x/y' }))]).size).toBe(0);
  });
  it('keeps the chip when an external engine failed', () => {
    const d = decision({ fallbackFrom: 'x/y', externalEngine: { failure: { suggestion: 's' } } } as Partial<ModelDecisionEventData>);
    expect(getFallbackDuplicateChipNodeIds([text('a', d), banner]).size).toBe(0);
  });
  it('keeps a non-fallback strategy chip in the same turn', () => {
    const ids = getFallbackDuplicateChipNodeIds([
      text('a', decision({ fallbackFrom: 'x/y' })), banner, text('s', decision({ reason: 'strategy-fast' })),
    ]);
    expect([...ids]).toEqual(['a']);
  });
  it('ignores nodes without a decision', () => {
    expect(getFallbackDuplicateChipNodeIds([text('a'), banner]).size).toBe(0);
  });
});
