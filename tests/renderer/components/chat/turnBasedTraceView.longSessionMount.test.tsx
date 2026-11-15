// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceProjection } from '../../../../src/shared/contract/trace';
import { languages } from '../../../../src/renderer/i18n';

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return {
    Virtuoso: ReactModule.forwardRef(function MockVirtuoso(props: Record<string, any>, ref) {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn() }));
      return ReactModule.createElement(
        'div',
        { role: props.role, 'aria-label': props['aria-label'] },
        props.data.map((turn: TraceProjection['turns'][number], index: number) => ReactModule.createElement(
          ReactModule.Fragment,
          { key: turn.turnId },
          props.itemContent(props.firstItemIndex + index, turn),
        )),
      );
    }),
  };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const state = { currentSessionId: 'long-session', sessions: [], messages: [], runningSessionIds: new Set<string>() };
  const useSessionStore = (selector?: (value: typeof state) => unknown) => selector ? selector(state) : state;
  useSessionStore.getState = () => state;
  return { useSessionStore };
});

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    createForkFromReply: vi.fn(),
    sendPrompt: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/components/PermissionDialog/PermissionCard', () => ({
  PermissionCard: () => null,
}));

import { TurnBasedTraceView } from '../../../../src/renderer/components/features/chat/TurnBasedTraceView';

afterEach(cleanup);

function longSessionProjection(turnCount = 2): TraceProjection {
  return {
    sessionId: 'long-session',
    activeTurnIndex: turnCount - 1,
    turns: Array.from({ length: turnCount }, (_, index) => index + 1).map((turnNumber) => ({
      turnNumber,
      turnId: `turn-${turnNumber}`,
      status: turnNumber === 2 ? ('streaming' as const) : ('completed' as const),
      startTime: turnNumber * 1_000,
      endTime: turnNumber * 1_000 + 500,
      nodes: [
        {
          id: `user-${turnNumber}`,
          type: 'user' as const,
          content: `Question ${turnNumber}`,
          timestamp: turnNumber * 1_000,
        },
        ...(turnNumber === 2 ? [{
          id: 'tool-2',
          type: 'tool_call' as const,
          content: '',
          timestamp: 2_100,
          toolCall: {
            id: 'tool-call-2',
            name: 'Read',
            args: { file_path: '/src/example.ts' },
            result: 'line 1',
            success: true,
            duration: 10,
          },
        }] : []),
        {
          id: `assistant-${turnNumber}`,
          type: 'assistant_text' as const,
          content: `## Answer ${turnNumber}\n\nA markdown answer.\n\n\`\`\`ts\nconst value = ${turnNumber};\n\`\`\``,
          timestamp: turnNumber * 1_000 + 300,
        },
      ],
    })),
  };
}

describe('TurnBasedTraceView long-session mount path', () => {
  it('reuses the translation key walk across mounted turns', () => {
    const originalEntries = Object.entries;
    const translationObjects = new WeakSet<object>();
    let translationObjectCount = 0;
    const collectObjects = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || translationObjects.has(value)) return;
      translationObjects.add(value);
      translationObjectCount += 1;
      for (const [, child] of originalEntries(value)) collectObjects(child);
    };
    collectObjects(languages.zh);
    let translationEntryCalls = 0;
    const entries = vi.spyOn(Object, 'entries').mockImplementation((value) => {
      if (translationObjects.has(value)) translationEntryCalls += 1;
      return originalEntries(value);
    });
    try {
      render(
        <TurnBasedTraceView projection={longSessionProjection(48)} />,
      );
      expect(translationEntryCalls).toBeLessThanOrEqual(translationObjectCount * 2);
    } finally {
      entries.mockRestore();
    }
  });

  it('renders markdown, a code block, and a tool card through the real trace view', async () => {
    render(<TurnBasedTraceView projection={longSessionProjection()} />);

    expect(document.querySelectorAll('[data-trace-turn-id]')).toHaveLength(2);
    expect(within(document.querySelector('[data-trace-turn-id="turn-1"]') as HTMLElement).getByText(/A markdown answer/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-code-block-lines="1"]')).not.toBeNull());
    expect(document.querySelector('[data-testid="tool-group-head-label"]')).not.toBeNull();
  });
});
