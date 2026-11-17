// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sendWithImmediateAssistantFeedback,
  transitionAssistantFeedback,
  type AssistantFeedbackState,
} from '../../../src/renderer/utils/sendWithImmediateAssistantFeedback';
import { StreamingIndicator } from '../../../src/renderer/components/features/chat/StreamingIndicator';

import { useAssistantFeedbackEvents } from '../../../src/renderer/components/features/chat/useAssistantFeedbackEvents';
import type { AgentEventEnvelope } from '../../../src/shared/contract';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { STARTUP_TIMEOUTS } from '../../../src/shared/constants';

const listeners = vi.hoisted(() => new Map<string, (event: AgentEventEnvelope) => void>());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { on: vi.fn((channel: string, callback: (event: AgentEventEnvelope) => void) => {
    listeners.set(channel, callback);
    return () => listeners.delete(channel);
  }) },
}));

function emit(event: AgentEventEnvelope) {
  act(() => listeners.get('agent:event')?.(event));
}

function PendingSendHarness({ send, liveStage }: {
  send: () => Promise<boolean>; liveStage?: 'approval' | 'tool';
}) {
  const [feedback, setFeedback] = useState<AssistantFeedbackState | null>(null);
  useAssistantFeedbackEvents(setFeedback);
  const clientMessageId = 'message-1';
  const sessionId = 'session-1';

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void sendWithImmediateAssistantFeedback({
            showFeedback: () => setFeedback((current) => transitionAssistantFeedback(current, {
              type: 'send_started',
              startedAt: Date.now(),
              clientMessageId,
              sessionId,
            })),
            clearFeedback: () => setFeedback((current) => transitionAssistantFeedback(current, {
              type: 'send_failed',
              clientMessageId,
              sessionId,
            })),
            send,
          });
        }}
      >
        发送
      </button>
      <button type="button" onClick={() => setFeedback((current) => transitionAssistantFeedback(current, {
        type: 'enqueue_succeeded', clientMessageId, sessionId,
      }))}>enqueue 成功</button>
      <button type="button" onClick={() => setFeedback((current) => transitionAssistantFeedback(current, {
        type: 'durable_activated', clientMessageId, sessionId,
      }))}>durable 激活</button>
      <button type="button" onClick={() => setFeedback((current) => transitionAssistantFeedback(current, {
        type: 'model_delta', sessionId,
      }))}>首个 delta</button>
      <button type="button" onClick={() => setFeedback((current) => transitionAssistantFeedback(current, {
        type: 'run_finished', sessionId,
      }))}>run 结束</button>
      {feedback === null && liveStage && (
        <StreamingIndicator startTime={Date.now()} waitingReason={liveStage === 'approval' ? 'approval' : undefined} />
      )}
      {feedback !== null && (
        <div data-testid="assistant-send-placeholder">
          <StreamingIndicator
            startTime={feedback.startedAt}
            preparationPhase={feedback.phase === 'submitting'
              ? 'submitting'
              : feedback.phase === 'queued' ? 'queued' : undefined}
            waitingReason={feedback.phase === 'waiting_model' ? 'model' : undefined}
          />
        </div>
      )}
    </div>
  );
}

describe('ChatView first-turn assistant feedback', () => {
  beforeEach(() => { useAppStore.setState({ language: 'zh' }); });
  afterEach(() => {
    useAppStore.setState({ language: 'zh' });
    vi.useRealTimers();
  });

  it('renders non-empty assistant feedback immediately while the send action is still awaiting its first event', () => {
    const send = vi.fn(() => new Promise<boolean>(() => {}));
    render(<PendingSendHarness send={send} />);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(send).toHaveBeenCalledOnce();
    const placeholder = screen.getByTestId('assistant-send-placeholder');
    expect(placeholder.textContent?.trim()).toBe('正在发送消息…');
    expect(screen.getAllByTestId('assistant-send-placeholder')).toHaveLength(1);
  });

  it('removes the local signal when auth or model configuration rejects the send', async () => {
    const send = vi.fn(async () => false);
    render(<PendingSendHarness send={send} />);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(screen.queryByTestId('assistant-send-placeholder')).toBeNull();
    });
  });

  it('keeps real phases event-driven while overdue admission copy changes once', () => {
    vi.useFakeTimers();
    const send = vi.fn(() => new Promise<boolean>(() => {}));
    render(<PendingSendHarness send={send} />);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => vi.advanceTimersByTime(STARTUP_TIMEOUTS.SLOW_START_NOTICE_MS - 1));
    expect(screen.getByTestId('assistant-send-placeholder').textContent).toContain('正在发送消息…');
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('assistant-send-placeholder').textContent).toBe(zh.chat.slowStarting);
    expect(screen.getByTestId('streaming-preparation-indicator').getAttribute('data-preparation-phase')).toBe('submitting');

    fireEvent.click(screen.getByRole('button', { name: 'enqueue 成功' }));
    expect(screen.getByTestId('assistant-send-placeholder').textContent).toBe(zh.chat.slowStarting);
    expect(screen.getByTestId('streaming-preparation-indicator').getAttribute('data-preparation-phase')).toBe('queued');
    expect(screen.getAllByTestId('assistant-send-placeholder')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'durable 激活' }));
    expect(screen.getByTestId('assistant-send-placeholder').textContent).toContain('信号传输中，正在等待模型回响…');
    expect(screen.getAllByTestId('assistant-send-placeholder')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '首个 delta' }));
    expect(screen.queryByTestId('assistant-send-placeholder')).toBeNull();
  });

  it('does not regress to queued copy when the activation event wins the cross-process race', () => {
    const send = vi.fn(() => new Promise<boolean>(() => {}));
    render(<PendingSendHarness send={send} />);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('button', { name: 'durable 激活' }));
    fireEvent.click(screen.getByRole('button', { name: 'enqueue 成功' }));

    expect(screen.getByTestId('assistant-send-placeholder').textContent).toContain('信号传输中，正在等待模型回响…');
  });

  // FU3-FU1-FU1 真跑实录：直接投递（starter 卡）没有 durable 队列，task_start 不带
  // clientMessageId，占位停在 submitting 档——首个 model delta 若只认 waiting_model 档，
  // 「正在发送消息…」会浮在整个 run 的正文上直到 agent_complete 也不消失。
  it('clears the placeholder on the first model delta regardless of phase (direct delivery never reaches waiting_model)', () => {
    const send = vi.fn(() => new Promise<boolean>(() => {}));
    render(<PendingSendHarness send={send} />);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(screen.getByTestId('assistant-send-placeholder').textContent).toContain('正在发送消息…');

    fireEvent.click(screen.getByRole('button', { name: '首个 delta' }));
    expect(screen.queryByTestId('assistant-send-placeholder')).toBeNull();
  });

  it('clears the placeholder when the run completes (agent_complete) even if no delta ever arrived', () => {
    const send = vi.fn(() => new Promise<boolean>(() => {}));
    render(<PendingSendHarness send={send} />);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('button', { name: 'run 结束' }));

    expect(screen.queryByTestId('assistant-send-placeholder')).toBeNull();
  });

  it('ignores run_finished for a different session', () => {
    const send = vi.fn(() => new Promise<boolean>(() => {}));
    render(<PendingSendHarness send={send} />);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const state: AssistantFeedbackState | null = transitionAssistantFeedback(
      {
        phase: 'submitting',
        startedAt: 1,
        clientMessageId: 'message-1',
        sessionId: 'session-1',
      },
      { type: 'run_finished', sessionId: 'session-other' },
    );
    expect(state).not.toBeNull();
  });

  const liveEvents: AgentEventEnvelope[] = [
    { type: 'tool_call_start', data: { id: 'call-1', name: 'Write', arguments: { file_path: 'summary.md', content: '- Launch Friday' } }, streamEpoch: 'test', sessionId: 'session-1', seq: 1 },
    { type: 'tool_call_end', data: { toolCallId: 'call-1', success: true, output: 'Saved summary.md' }, streamEpoch: 'test', sessionId: 'session-1', seq: 2 },
    { type: 'permission_request', data: { id: 'permission-1', type: 'file_write', tool: 'Write', details: { path: 'summary.md' }, timestamp: 1, sessionId: 'session-1' }, streamEpoch: 'test', sessionId: 'session-1', seq: 3 },
  ];

  for (const language of ['zh', 'en'] as const) {
    it.each(liveEvents)('hands the sending slot to the live turn on $type without any delta (' + language + ')', (event) => {
      useAppStore.setState({ language });
      render(<PendingSendHarness send={() => new Promise<boolean>(() => {})} liveStage={event.type === 'permission_request' ? 'approval' : 'tool'} />);
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      expect(screen.getByTestId('assistant-send-placeholder')).not.toBeNull();
      emit({ ...event, sessionId: 'another-session' });
      expect(screen.getByTestId('assistant-send-placeholder')).not.toBeNull();
      emit(event);
      expect(screen.queryByTestId('assistant-send-placeholder')).toBeNull();
      expect(screen.queryByText(/正在发送消息|Sending message/)).toBeNull();
      if (event.type === 'permission_request') {
        expect(screen.getByLabelText((language === 'zh' ? zh : en).chat.waitingApproval).textContent)
          .toBe((language === 'zh' ? zh : en).chat.waitingApproval);
      } else {
        expect(document.querySelector('.streaming-caret')).not.toBeNull();
      }
    });
  }

  it('keeps a live-event dismissal after late durable/enqueue acknowledgements and ignores missing session identity', () => {
    render(<PendingSendHarness send={() => new Promise<boolean>(() => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    emit({ ...liveEvents[0], sessionId: undefined } as unknown as AgentEventEnvelope);
    expect(screen.getByTestId('assistant-send-placeholder')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'durable 激活' }));
    emit(liveEvents[0]);
    fireEvent.click(screen.getByRole('button', { name: 'enqueue 成功' }));
    fireEvent.click(screen.getByRole('button', { name: 'durable 激活' }));
    expect(screen.queryByTestId('assistant-send-placeholder')).toBeNull();
  });

});
