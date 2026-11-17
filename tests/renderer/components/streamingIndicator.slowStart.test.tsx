// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STARTUP_TIMEOUTS } from '../../../src/shared/constants';
import { StreamingIndicator } from '../../../src/renderer/components/features/chat/StreamingIndicator';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const threshold = STARTUP_TIMEOUTS.SLOW_START_NOTICE_MS;
const indicator = () => screen.getByTestId('streaming-preparation-indicator');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  vi.useRealTimers();
});

describe.each(['zh', 'en'] as const)('slow-start feedback (%s)', (language) => {
  const copy = language === 'zh' ? zh.chat : en.chat;

  it.each(['submitting', 'queued'] as const)('changes %s at the threshold exactly, once, without a counter', (phase) => {
    useAppStore.setState({ language });
    const startTime = Date.now();
    const view = render(<StreamingIndicator startTime={startTime} preparationPhase={phase} />);
    const initial = phase === 'submitting' ? copy.sendingMessage : copy.queuedStarting;
    expect(indicator().textContent).toBe(initial);
    act(() => vi.advanceTimersByTime(threshold - 1));
    expect(indicator().textContent).toBe(initial);
    act(() => vi.advanceTimersByTime(1));
    expect(indicator().textContent).toBe(copy.slowStarting);
    expect(indicator().getAttribute('data-preparation-phase')).toBe(phase);
    expect(indicator().getAttribute('aria-label')).toBe(copy.slowStarting);
    act(() => vi.advanceTimersByTime(threshold * 6));
    expect(indicator().textContent).toBe(copy.slowStarting);
    // Once shown, a clock correction or an unrelated re-render must not undo it.
    vi.setSystemTime(startTime);
    view.rerender(<StreamingIndicator startTime={startTime} preparationPhase={phase} />);
    expect(indicator().textContent).toBe(copy.slowStarting);
    expect(indicator().textContent).not.toMatch(/\d/);
  });

  it('uses the original send time when mounted partway through admission', () => {
    useAppStore.setState({ language });
    render(<StreamingIndicator startTime={Date.now() - threshold + 1} preparationPhase="submitting" />);
    expect(indicator().textContent).toBe(copy.sendingMessage);
    act(() => vi.advanceTimersByTime(1));
    expect(indicator().textContent).toBe(copy.slowStarting);
  });

  it('renders an already overdue send on the first frame', () => {
    useAppStore.setState({ language });
    render(<StreamingIndicator startTime={Date.now() - threshold} preparationPhase="submitting" />);
    expect(indicator().textContent).toBe(copy.slowStarting);
  });

  it('resets for a new send and yields immediately to the actual phase', () => {
    useAppStore.setState({ language });
    const startTime = Date.now();
    const view = render(<StreamingIndicator startTime={startTime} preparationPhase="submitting" />);
    act(() => vi.advanceTimersByTime(threshold));
    expect(indicator().textContent).toBe(copy.slowStarting);
    view.rerender(<StreamingIndicator startTime={startTime} preparationPhase="preparing" />);
    expect(indicator().textContent).toBe(copy.preparingReply);
    view.rerender(<StreamingIndicator startTime={startTime} preparationPhase="organizing" />);
    expect(indicator().textContent).toBe(copy.organizingStreamingReply);
    view.rerender(<StreamingIndicator startTime={startTime} waitingReason="model" />);
    expect(screen.queryByTestId('streaming-preparation-indicator')).toBeNull();
    expect(screen.getByLabelText(copy.waitingModel)).toBeTruthy();
    const nextStart = Date.now();
    view.rerender(<StreamingIndicator startTime={nextStart} preparationPhase="queued" />);
    expect(indicator().textContent).toBe(copy.queuedStarting);
    act(() => vi.advanceTimersByTime(threshold - 1));
    expect(indicator().textContent).toBe(copy.queuedStarting);
    act(() => vi.advanceTimersByTime(1));
    expect(indicator().textContent).toBe(copy.slowStarting);
  });

  it('cancels an old phase timer when the run starts or the indicator unmounts', () => {
    useAppStore.setState({ language });
    const startTime = Date.now();
    const view = render(<StreamingIndicator startTime={startTime} preparationPhase="submitting" />);
    act(() => vi.advanceTimersByTime(threshold - 1));
    view.rerender(<StreamingIndicator startTime={startTime} preparationPhase="preparing" />);
    act(() => vi.advanceTimersByTime(threshold * 2));
    expect(indicator().textContent).toBe(copy.preparingReply);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
