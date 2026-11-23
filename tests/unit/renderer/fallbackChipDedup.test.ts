import { describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { ModelDecisionEventData } from '../../../src/shared/contract';
import { getFallbackDuplicateChipNodeIds } from '../../../src/renderer/utils/fallbackChipDedup';

const decision = (o: Partial<ModelDecisionEventData>) => ({
  reason: 'user-selected', requestedModel: 'a', resolvedModel: 'a', fallbackFrom: null, ...o,
}) as ModelDecisionEventData;
const text = (id: string, d?: ModelDecisionEventData): TraceNode => ({ id, type: 'assistant_text', content: 'x', timestamp: 1, modelDecision: d });
const noticeFrom = (from: string) => JSON.stringify({ __modelFallbackNotice: { reason: 'r', from, to: 'z/w' } });
const bannerFor = (id: string, from: string): TraceNode => ({ id, type: 'system', content: noticeFrom(from), timestamp: 1, subtype: 'model_fallback' });
const banner = bannerFor('b', 'x/y');

describe('getFallbackDuplicateChipNodeIds', () => {
  it('hides fallbackFrom chip when the turn has a banner', () => {
    expect([...getFallbackDuplicateChipNodeIds([text('a', decision({ fallbackFrom: 'x/y' })), banner])]).toEqual(['a']);
  });
  it('keeps a fallback-availability chip that has no fallbackFrom to match the banner', () => {
    expect(getFallbackDuplicateChipNodeIds([banner, text('a', decision({ reason: 'fallback-availability', resolvedModel: 'b' }))]).size).toBe(0);
  });
  it('keeps a missing-key chip when the turn banner belongs to a different fallback', () => {
    const ids = getFallbackDuplicateChipNodeIds([
      text('nokey', decision({ fallbackFrom: 'zhipu/glm-5' })), text('real', decision({ fallbackFrom: 'x/y' })), banner,
    ]);
    expect([...ids]).toEqual(['real']);
  });
  it('ignores a banner whose content cannot be parsed', () => {
    const bad: TraceNode = { ...banner, content: 'not json' };
    expect(getFallbackDuplicateChipNodeIds([text('a', decision({ fallbackFrom: 'x/y' })), bad]).size).toBe(0);
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
