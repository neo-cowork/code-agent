// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { languages } from '../../../src/renderer/i18n';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { applyConversationStreamEvent } from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';
import { useTurnProjection } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { filterSystemTags } from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';
import { formatBlockDetail } from '../../../src/renderer/components/features/sidebar/sessionReplayFormatters';
import { SidebarMessageHitList } from '../../../src/renderer/components/features/sidebar/SidebarMessageHitList';

const ENVELOPE =
  '<command-message>Loading skill: frontend-slides</command-message><command-name>frontend-slides</command-name><command-content-hash>f7a817c25c8a55b7</command-content-hash>';

function createStreamState() {
  return {
    currentTurnMessageId: null as string | null,
    committedAssistantMessageIds: new Set<string>(),
    lastDeltaSeqByTurn: new Map<string, number>(),
    segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
  };
}

beforeEach(() => {
  useAppStore.setState({ developerMode: false, cloudUIStrings: null });
  useSessionStore.setState({
    currentSessionId: 'session-skill-envelope',
    sessions: [],
    messages: [],
    runningSessionIds: new Set<string>(),
  });
});

afterEach(() => {
  cleanup();
});

describe.each([
  { language: 'zh' as const, expectedHuman: '使用了技能 frontend-slides' },
  { language: 'en' as const, expectedHuman: 'Used the frontend-slides skill' },
])('skill activation status envelope ($language)', ({ language, expectedHuman }) => {
  beforeEach(() => {
    useAppStore.setState({ language });
  });

  it('live path: preserves source through applyConversationStreamEvent, projects with useTurnProjection, and renders human line without raw tags', () => {
    let messages: Message[] = [
      {
        id: 'user-prompt-1',
        role: 'user',
        content: language === 'zh' ? '做一份季度汇报 PPT' : 'Make a quarterly report presentation',
        timestamp: 1_000,
      },
    ];
    const state = createStreamState();

    applyConversationStreamEvent(
      {
        type: 'message',
        data: {
          id: 'skill-envelope-live-1',
          role: 'user',
          content: ENVELOPE,
          source: 'skill',
          isMeta: false,
          metadata: {
            skill: {
              skillName: 'frontend-slides',
              phase: 'status',
            },
          },
        },
      },
      state,
      {
        addMessage: (message) => {
          messages = [...messages, message];
        },
        updateMessage: () => {},
        setMessages: (next) => {
          messages = next;
        },
        getMessages: () => messages,
        queueUpdate: () => {},
        now: () => 2_000,
        generateId: () => 'generated-id',
      },
    );

    const storedEnvelope = messages.find((msg) => msg.id === 'skill-envelope-live-1');
    expect(storedEnvelope?.source).toBe('skill');

    const { result } = renderHook(() =>
      useTurnProjection(messages, 'session-skill-envelope', false),
    );
    const projectedNode = result.current.turns
      .flatMap((turn) => turn.nodes)
      .find((node) => node.id === 'skill-envelope-live-1');
    expect(projectedNode).toBeDefined();

    const { container } = render(
      <TraceNodeRenderer node={projectedNode!} sessionId="session-skill-envelope" />,
    );
    const visibleText = container.textContent ?? '';
    expect(visibleText).not.toContain('<command-');
    expect(visibleText).not.toContain('Loading skill');
    expect(visibleText).toContain(expectedHuman);
    expect(container.querySelector('.skill-status')).not.toBeNull();
    expect(result.current.turns).toHaveLength(1);
  });

  it('reload shape (no source): projects through isSkillStatusMessage and renders human line without raw tags', () => {
    const messages: Message[] = [
      {
        id: 'user-prompt-1',
        role: 'user',
        content: language === 'zh' ? '做一份季度汇报 PPT' : 'Make a quarterly report presentation',
        timestamp: 1_000,
      },
      {
        id: 'skill-envelope-reload-1',
        role: 'user',
        content: ENVELOPE,
        timestamp: 2_000,
        isMeta: false,
        metadata: {
          skill: {
            skillName: 'frontend-slides',
            phase: 'status',
          },
        },
      },
    ];

    const { result } = renderHook(() =>
      useTurnProjection(messages, 'session-skill-envelope', false),
    );
    const projectedNode = result.current.turns
      .flatMap((turn) => turn.nodes)
      .find((node) => node.id === 'skill-envelope-reload-1');
    expect(projectedNode).toBeDefined();

    const { container } = render(
      <TraceNodeRenderer node={projectedNode!} sessionId="session-skill-envelope" />,
    );
    const visibleText = container.textContent ?? '';
    expect(visibleText).not.toContain('<command-');
    expect(visibleText).not.toContain('Loading skill');
    expect(visibleText).toContain(expectedHuman);
    expect(result.current.turns).toHaveLength(1);
  });

  it('replay and sidebar search paths humanize user rows carrying the skill envelope', () => {
    const t = languages[language];
    const replayDetail = formatBlockDetail(
      { type: 'user', content: ENVELOPE, timestamp: 2_000 },
      t.sessionReplay,
      t,
      language,
    );
    expect(replayDetail).not.toContain('<command-');
    expect(replayDetail).not.toContain('Loading skill');
    expect(replayDetail).toContain(expectedHuman);

    const { container } = render(
      <SidebarMessageHitList
        sessionId="session-skill-envelope"
        hits={[
          {
            sessionId: 'session-skill-envelope',
            messageId: 'hit-0',
            snippet: 'first hit',
            messagePositionLabel: '#1',
            role: 'user',
            timestamp: 1_000,
            matchCount: 1,
            relevance: 2,
          },
          {
            sessionId: 'session-skill-envelope',
            messageId: 'hit-1',
            snippet: ENVELOPE,
            messagePositionLabel: '#2',
            role: 'user',
            timestamp: 2_000,
            matchCount: 1,
            relevance: 1,
          },
        ]}
        onSelectHit={vi.fn()}
      />,
    );
    const sidebarText = container.textContent ?? '';
    expect(sidebarText).not.toContain('<command-');
    expect(sidebarText).not.toContain('Loading skill');
    expect(sidebarText).toContain(expectedHuman);
  });
});

describe('filterSystemTags fallback stripper', () => {
  it('strips <command-content-hash> alongside <command-message> and <command-name>', () => {
    expect(filterSystemTags(ENVELOPE)).toBe('');
    expect(filterSystemTags(`Hello\n${ENVELOPE}\nWorld`)).toBe('Hello\n\nWorld');
  });
});
