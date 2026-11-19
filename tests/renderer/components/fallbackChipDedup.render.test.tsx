// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, ModelDecisionEventData } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TurnBasedTraceView } from '../../../src/renderer/components/features/chat/TurnBasedTraceView';
import { encodeModelFallbackNotice } from '../../../src/renderer/components/features/chat/fallbackNotice';
import { useAppStore } from '../../../src/renderer/stores/appStore';

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return { Virtuoso: ReactModule.forwardRef(function Layout(props: {
    data: import('../../../src/shared/contract/trace').TraceTurn[];
    firstItemIndex: number;
    itemContent: (index: number, turn: import('../../../src/shared/contract/trace').TraceTurn) => React.ReactNode;
  }, ref) {
    ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex() {}, autoscrollToBottom() {} }));
    return <div>{props.data.map((turn, index) => <React.Fragment key={turn.turnId}>
      {props.itemContent(props.firstItemIndex + index, turn)}
    </React.Fragment>)}</div>;
  }) };
});

afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh', disclosureLevel: 'standard' }); });

const fallbackDecision = (o: Partial<ModelDecisionEventData> = {}): ModelDecisionEventData => ({
  turnId: 'turn-1', requestedProvider: 'moonshot', requestedModel: 'kimi-k2.5',
  resolvedProvider: 'zhipu', resolvedModel: 'glm-5', role: null, billingMode: 'unknown',
  fallbackFrom: 'moonshot/kimi-k2.5', reason: 'fallback-availability', ...o,
} as ModelDecisionEventData);

const notice: Message = {
  id: 'n1', role: 'system', source: 'model', timestamp: 3,
  content: encodeModelFallbackNotice({ reason: 'unavailable', from: 'moonshot/kimi-k2.5', to: 'zhipu/glm-5' }),
} as Message;

function renderTurn(assistant: Message[], withNotice: boolean) {
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: '总结 notes.txt', timestamp: 1 },
    ...assistant,
    ...(withNotice ? [notice] : []),
  ];
  return render(<TurnBasedTraceView projection={projectTurns(messages, 'session-1', false)} />);
}
const chips = (c: HTMLElement) => c.querySelectorAll('[data-testid="route-trace-chip"]').length;
const banners = (c: HTMLElement) => (c.textContent?.match(/已自动换用备用模型/g) ?? []).length;
const reply = (d: ModelDecisionEventData): Message => ({ id: 'a1', role: 'assistant', content: '已总结', timestamp: 2, modelDecision: d });

describe('fallback chip / banner de-dup through the real chat view', () => {
  it('shows only the banner for one fallback (also the restored-from-persistence shape)', () => {
    const { container } = renderTurn([reply(fallbackDecision())], true);
    expect(banners(container)).toBe(1);
    expect(chips(container)).toBe(0);
  });
  it('keeps the chip when fallbackFrom has no banner (no-API-key case)', () => {
    const { container } = renderTurn([reply(fallbackDecision())], false);
    expect(chips(container)).toBe(1);
    expect(banners(container)).toBe(0);
  });
  it('keeps an external engine failure chip next to the banner', () => {
    const d = fallbackDecision({
      externalEngine: {
        kind: 'codex_cli', label: 'Codex CLI', installState: 'installed', runtimeState: 'blocked', executable: true, capabilities: [],
        failure: { category: 'unknown', reason: 'x', message: 'm', suggestion: 's', retryable: false },
      },
    });
    const { container } = renderTurn([reply(d)], true);
    expect(chips(container)).toBe(1);
  });
  it('keeps a strategy chip from a later node in the same turn', () => {
    const strategy = fallbackDecision({ reason: 'strategy-fast', fallbackFrom: null, requestedModel: 'a', resolvedModel: 'b' });
    const { container } = renderTurn([reply(fallbackDecision()), { id: 'a2', role: 'assistant', content: '再补充', timestamp: 2.5, modelDecision: strategy }], true);
    expect(chips(container)).toBe(1);
    expect(banners(container)).toBe(1);
  });
});
