// @vitest-environment jsdom
// Production-entry guard: real useAssistantFeedbackEvents + real TurnCard (real tool rows,
// real StreamingIndicator) — no stand-in of the status slot. A turn whose first model output
// is a tool call must hand the send slot to the live turn, and the turn must show the tool
// as running (not the sending / preparation label).
import React, { useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEventEnvelope } from '../../../src/shared/contract';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { AssistantFeedbackIndicator } from '../../../src/renderer/components/features/chat/AssistantFeedbackIndicator';
import { useAssistantFeedbackEvents } from '../../../src/renderer/components/features/chat/useAssistantFeedbackEvents';
import {
  transitionAssistantFeedback,
  type AssistantFeedbackState,
} from '../../../src/renderer/utils/sendWithImmediateAssistantFeedback';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const listeners = vi.hoisted(() => new Map<string, (event: AgentEventEnvelope) => void>());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(async () => undefined), invokeDomain: vi.fn(async () => undefined), on: vi.fn((channel: string, callback: (event: AgentEventEnvelope) => void) => {
    listeners.set(channel, callback);
    return () => listeners.delete(channel);
  }) },
}));

const baseTime = 1_800_000_000_000;
const sessionId = 'session-1';

// Mirrors ChatView's wiring: placeholder while feedback !== null, and the turn's own busy
// signal is muted only while that placeholder is up.
function LiveTurn({ turn }: { turn: TraceTurn }) {
  const [feedback, setFeedback] = useState<AssistantFeedbackState | null>(() => transitionAssistantFeedback(null, {
    type: 'send_started', startedAt: baseTime, clientMessageId: 'message-1', sessionId,
  }));
  useAssistantFeedbackEvents(setFeedback);
  return (
    <div>
      <TurnCard turn={turn} sessionId={sessionId} isActiveTurn isLastTurn isSessionProcessing suppressBusySignal={feedback !== null} />
      {feedback !== null && (
        <div data-testid="assistant-send-placeholder">
          <AssistantFeedbackIndicator feedback={feedback} />
        </div>
      )}
    </div>
  );
}

function runningWriteTurn(): TraceTurn {
  return {
    turnNumber: 1, turnId: 'turn-1', status: 'streaming', startTime: baseTime,
    nodes: [
      { id: 'user-1', type: 'user', content: 'zip the photos folder', timestamp: baseTime },
      {
        id: 'tool-1', type: 'tool_call', content: '', timestamp: baseTime + 100,
        toolCall: { id: 'call-1', name: 'Write', args: { file_path: 'summary.md', content: '- Launch Friday' } },
      },
    ],
  };
}

const toolStart: AgentEventEnvelope = {
  type: 'tool_call_start',
  data: { id: 'call-1', name: 'Write', arguments: { file_path: 'summary.md', content: '- Launch Friday' } },
  streamEpoch: 'test', sessionId, seq: 1,
};

describe('TurnCard running-tool status after the send placeholder is released', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(baseTime + 3_000);
    // the store marks the session as processing for the whole live run
    useAppStore.setState({ processingSessionIds: new Set([sessionId]) });
  });
  afterEach(() => {
    cleanup();
    useAppStore.setState({ language: 'zh', processingSessionIds: new Set<string>(), pendingPermissionRequest: null, pendingPermissionSessionId: null, queuedPermissionRequests: {} });
    vi.useRealTimers();
  });

  for (const language of ['zh', 'en'] as const) {
    it('shows the running tool and no sending/preparation label once tool_call_start proves the run is live (' + language + ')', () => {
      useAppStore.setState({ language });
      const labels = (language === 'zh' ? zh : en).chat;
      render(<LiveTurn turn={runningWriteTurn()} />);
      expect(screen.getByTestId('assistant-send-placeholder').textContent).toContain(labels.sendingMessage);

      act(() => listeners.get('agent:event')?.(toolStart));

      expect(screen.queryByTestId('assistant-send-placeholder')).toBeNull();
      expect(screen.queryByText(labels.sendingMessage)).toBeNull();
      expect(screen.queryByTestId('streaming-preparation-indicator')).toBeNull();
      expect(screen.queryByLabelText(labels.waitingApproval)).toBeNull();
      // real tool row: the running Write is rendered by the production tool-step component
      expect(document.body.textContent).toMatch(language === 'zh' ? /写入中…正在写入 summary\.md/ : /Writing…Writing summary\.md/);
      expect(document.body.textContent).not.toMatch(/已中断|Interrupted/);
    });
  }
});
