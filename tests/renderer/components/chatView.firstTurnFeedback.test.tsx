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
import { AssistantFeedbackIndicator } from '../../../src/renderer/components/features/chat/AssistantFeedbackIndicator';

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
          <AssistantFeedbackIndicator feedback={feedback} />
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
    expect(screen.getByTestId('assistant-send-placeholder').textContent).toContain(zh.chat.preparingReply);
    expect(screen.getByTestId('streaming-preparation-indicator').getAttribute('data-preparation-phase')).toBe('preparing');
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

    expect(screen.getByTestId('assistant-send-placeholder').textContent).toContain(zh.chat.preparingReply);
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


  const taskStart = (cm: string, sid = 'session-1'): AgentEventEnvelope => ({
    type: 'task_start', sessionId: sid, data: { sessionId: sid, clientMessageId: cm },
  } as unknown as AgentEventEnvelope);

  it('task_start carrying this send\'s clientMessageId moves submitting to preparing (正在准备…) and keeps it there', () => {
    render(<PendingSendHarness send={() => new Promise<boolean>(() => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(screen.getByTestId('streaming-preparation-indicator').getAttribute('data-preparation-phase')).toBe('submitting');
    emit(taskStart('message-1'));
    expect(screen.getByTestId('streaming-preparation-indicator').getAttribute('data-preparation-phase')).toBe('preparing');
    expect(screen.getByTestId('assistant-send-placeholder').textContent?.trim()).toBe(zh.chat.preparingReply);
    expect(screen.queryByText(zh.chat.waitingModel)).toBeNull();
    // never goes backwards
    fireEvent.click(screen.getByRole('button', { name: 'enqueue 成功' }));
    expect(screen.getByTestId('streaming-preparation-indicator').getAttribute('data-preparation-phase')).toBe('preparing');
  });

  it('ignores a task_start for another clientMessageId or another session', () => {
    render(<PendingSendHarness send={() => new Promise<boolean>(() => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    emit(taskStart('someone-else'));
    emit(taskStart('message-1', 'another-session'));
    expect(screen.getByTestId('streaming-preparation-indicator').getAttribute('data-preparation-phase')).toBe('submitting');
  });

  // r4 hole: a context-free turn_start must never advance a queued send.
  it('turn_start arriving before enqueue_succeeded leaves the send on 正在发送消息… and then on 已排队，正在启动…', () => {
    render(<PendingSendHarness send={() => new Promise<boolean>(() => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    emit({ type: 'turn_start', data: { turnId: 't-1' }, streamEpoch: 'test', sessionId: 'session-1', seq: 1 } as unknown as AgentEventEnvelope);
    expect(screen.getByTestId('streaming-preparation-indicator').getAttribute('data-preparation-phase')).toBe('submitting');
    fireEvent.click(screen.getByRole('button', { name: 'enqueue 成功' }));
    expect(screen.getByTestId('streaming-preparation-indicator').getAttribute('data-preparation-phase')).toBe('queued');
    expect(screen.getByTestId('assistant-send-placeholder').textContent?.trim()).toBe(zh.chat.queuedStarting);
  });

  const clearing: AgentEventEnvelope[] = [
    { type: 'message_delta', data: { text: 'x' }, streamEpoch: 'test', sessionId: 'session-1', seq: 9 },
    { type: 'stream_chunk', data: { content: 'x' }, streamEpoch: 'test', sessionId: 'session-1', seq: 9 },
    { type: 'stream_tool_call_start', data: { index: 0, name: 'Write' }, streamEpoch: 'test', sessionId: 'session-1', seq: 9 },
    { type: 'agent_cancelled', data: {}, streamEpoch: 'test', sessionId: 'session-1', seq: 9 },
  ] as unknown as AgentEventEnvelope[];
  it.each(clearing)('preparing indicator clears on $type for the same session and ignores another session', (event) => {
    render(<PendingSendHarness send={() => new Promise<boolean>(() => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    emit(taskStart('message-1'));
    expect(screen.getByTestId('streaming-preparation-indicator').getAttribute('data-preparation-phase')).toBe('preparing');
    emit({ ...event, sessionId: 'another-session' });
    expect(screen.getByTestId('streaming-preparation-indicator').getAttribute('data-preparation-phase')).toBe('preparing');
    emit(event);
    expect(screen.queryByTestId('assistant-send-placeholder')).toBeNull();
  });

  it('queued copy stays until the activation arrives, then becomes 正在准备…', () => {
    render(<PendingSendHarness send={() => new Promise<boolean>(() => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('button', { name: 'enqueue 成功' }));
    expect(screen.getByTestId('assistant-send-placeholder').textContent?.trim()).toBe(zh.chat.queuedStarting);
    emit({ type: 'stream_end', data: {}, sessionId: 'another-session' } as unknown as AgentEventEnvelope);
    expect(screen.getByTestId('assistant-send-placeholder').textContent?.trim()).toBe(zh.chat.queuedStarting);
    fireEvent.click(screen.getByRole('button', { name: 'durable 激活' }));
    expect(screen.getByTestId('assistant-send-placeholder').textContent?.trim()).toBe(zh.chat.preparingReply);
  });

});
