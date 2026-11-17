// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { STARTUP_TIMEOUTS } from '@shared/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantFeedbackIndicator } from '../../../src/renderer/components/features/chat/AssistantFeedbackIndicator';
import { useAssistantFeedbackEvents } from '../../../src/renderer/components/features/chat/useAssistantFeedbackEvents';
import { transitionAssistantFeedback, type AssistantFeedbackState } from '../../../src/renderer/utils/sendWithImmediateAssistantFeedback';

const listeners = vi.hoisted(() => new Map<string, (event: never) => void>());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { on: (channel: string, cb: (event: never) => void) => { listeners.set(channel, cb); return () => listeners.delete(channel); } },
}));

function Harness() {
  const [feedback, setFeedback] = useState<AssistantFeedbackState | null>(null);
  useAssistantFeedbackEvents(setFeedback);
  return <>
    <button onClick={() => setFeedback(transitionAssistantFeedback(null, { type: 'send_started', startedAt: Date.now(), clientMessageId: 'm', sessionId: 's' }))}>send</button>
    <button onClick={() => setFeedback((cur) => transitionAssistantFeedback(cur, { type: 'durable_activated', clientMessageId: 'm', sessionId: 's' }))}>activate</button>
    {feedback && <AssistantFeedbackIndicator feedback={feedback} />}
  </>;
}

describe('pre-reply feedback', () => {
  beforeEach(() => listeners.clear());
  it.each(['message_delta', 'stream_chunk', 'stream_tool_call_start', 'agent_cancelled'])('shows preparation immediately and clears on %s', (type) => {
    render(<Harness />);
    fireEvent.click(screen.getByText('send'));
    expect(screen.getByTestId('streaming-preparation-indicator').textContent).toBe('正在发送消息…');
    fireEvent.click(screen.getByText('activate'));
    expect(screen.getByTestId('streaming-preparation-indicator').textContent).toBe('正在准备…');
    act(() => listeners.get('agent:event')?.({ type, sessionId: 's' } as never));
    expect(screen.queryByTestId('streaming-preparation-indicator')).toBeNull();
  });
  it('keeps queued copy until activation, then shows preparation', () => {
    const base: AssistantFeedbackState = { phase: 'queued', startedAt: Date.now(), clientMessageId: 'm', sessionId: 's' };
    const { rerender } = render(<AssistantFeedbackIndicator feedback={base} />);
    expect(screen.getByTestId('streaming-preparation-indicator').textContent).toBe('已排队，正在启动…');
    rerender(<AssistantFeedbackIndicator feedback={{ ...base, phase: 'waiting_model' }} />);
    expect(screen.getByTestId('streaming-preparation-indicator').textContent).toBe('正在准备…');
  });
  it('ignores a different session stopping', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('send'));
    expect(screen.getByTestId('streaming-preparation-indicator').textContent).toBe('正在发送消息…');
    fireEvent.click(screen.getByText('activate'));
    act(() => listeners.get('agent:event')?.({ type: 'agent_cancelled', sessionId: 'other' } as never));
    expect(screen.getByTestId('streaming-preparation-indicator').textContent).toBe('正在准备…');
  });
  it('keeps the slow-start notice for a send that is still submitting past the threshold', () => {
    const base: AssistantFeedbackState = { phase: 'submitting', startedAt: Date.now() - STARTUP_TIMEOUTS.SLOW_START_NOTICE_MS - 1, clientMessageId: 'm', sessionId: 's' };
    render(<AssistantFeedbackIndicator feedback={base} />);
    expect(screen.getByTestId('streaming-preparation-indicator').textContent).toBe('启动比平时慢，请稍候…');
  });
  it('direct delivery: the first sequenced turn_start moves submitting to preparing before the first delta', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('send'));
    const indicator = () => screen.getByTestId('streaming-preparation-indicator');
    expect(indicator().getAttribute('data-preparation-phase')).toBe('submitting');
    act(() => listeners.get('agent:event')?.({ type: 'turn_start', sessionId: 's', data: { iteration: 1 } } as never));
    expect(indicator().getAttribute('data-preparation-phase')).toBe('preparing');
    expect(indicator().textContent).toBe('正在准备…');
    act(() => listeners.get('agent:event')?.({ type: 'message_delta', sessionId: 's' } as never));
    expect(screen.queryByTestId('streaming-preparation-indicator')).toBeNull();
  });
  it('turn_start of another session, or while queued, does not advance the placeholder', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('send'));
    act(() => listeners.get('agent:event')?.({ type: 'turn_start', sessionId: 'other' } as never));
    expect(screen.getByTestId('streaming-preparation-indicator').textContent).toBe('正在发送消息…');
    expect(transitionAssistantFeedback(
      { phase: 'queued', startedAt: Date.now(), clientMessageId: 'm', sessionId: 's' },
      { type: 'run_started', sessionId: 's' },
    )?.phase).toBe('queued');
  });
});
