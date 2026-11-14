// @vitest-environment jsdom
// N-FIX-FIX-BROWSER-SECRETREF-HARDEN（FB-578）：secretRef 接管停靠的聊天卡三态
// （takeover+kept / takeover+closed / 其他不渲染）+「继续」发送用户消息。
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserTakeoverParkCard } from '../../../../src/renderer/components/features/surfaceExecution/BrowserTakeoverParkCard';
import { useTaskStore } from '../../../../src/renderer/stores/taskStore';

const { getKeptResultPage, adoptKeptResultPage } = vi.hoisted(() => ({
  getKeptResultPage: vi.fn(),
  adoptKeptResultPage: vi.fn(),
}));

vi.mock('../../../../src/renderer/services/userBrowserLink', () => ({
  adoptKeptResultPage: (input: unknown) => adoptKeptResultPage(input),
  getKeptResultPage: (conversationId: string) => getKeptResultPage(conversationId),
}));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getKeptResultPage.mockReset();
  adoptKeptResultPage.mockReset().mockResolvedValue({});
  useTaskStore.setState({ sessionStates: {} });
});

afterEach(() => {
  cleanup();
  useTaskStore.setState({ sessionStates: {} });
  vi.useRealTimers();
});

describe('BrowserTakeoverParkCard', () => {
  it('renders nothing for state none and for keep_result_page entries', async () => {
    getKeptResultPage.mockResolvedValue({ state: 'none', url: null, title: null, reason: null });
    const { container } = render(
      <BrowserTakeoverParkCard conversationId="conversation-a" onContinue={() => undefined} />,
    );
    await waitFor(() => expect(getKeptResultPage).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();

    getKeptResultPage.mockResolvedValue({
      state: 'kept',
      url: 'https://example.test/result',
      title: 'Result',
      reason: 'keep_result_page',
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(container.firstChild).toBeNull();
  });

  it('parked state asks the user to sign in and Continue sends a user message', async () => {
    getKeptResultPage.mockResolvedValue({
      state: 'kept',
      url: 'https://idp.example.test/login',
      title: 'Sign in',
      reason: 'takeover',
    });
    const onContinue = vi.fn();
    render(<BrowserTakeoverParkCard conversationId="conversation-a" onContinue={onContinue} />);

    expect(await screen.findByText('浏览器已交给你')).toBeDefined();
    expect(screen.getByText(/完成登录/)).toBeDefined();
    const button = await screen.findByTestId('browser-takeover-park-continue');
    fireEvent.click(button);

    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    // The message is a user-visible sentence in the conversation language, not a resume call.
    expect(onContinue).toHaveBeenCalledWith('我已在浏览器窗口里登录完成，请继续刚才的任务。');
  });

  it('closed state says the sign-in was not kept and has no Continue button', async () => {
    getKeptResultPage.mockResolvedValue({
      state: 'closed',
      url: 'https://idp.example.test/login',
      title: 'Sign in',
      reason: 'takeover',
    });
    const onContinue = vi.fn();
    render(<BrowserTakeoverParkCard conversationId="conversation-a" onContinue={onContinue} />);

    expect(await screen.findByText('浏览器已关闭')).toBeDefined();
    expect(screen.getByText(/登录状态没有保留/)).toBeDefined();
    expect(screen.queryByTestId('browser-takeover-park-continue')).toBeNull();
  });

  it('flips from parked to closed when the poll observes the reclaim', async () => {
    getKeptResultPage.mockResolvedValueOnce({
      state: 'kept',
      url: 'https://idp.example.test/login',
      title: 'Sign in',
      reason: 'takeover',
    }).mockResolvedValue({
      state: 'closed',
      url: 'https://idp.example.test/login',
      title: 'Sign in',
      reason: 'takeover',
    });
    render(<BrowserTakeoverParkCard conversationId="conversation-a" onContinue={() => undefined} />);

    expect(await screen.findByText('浏览器已交给你')).toBeDefined();
    await vi.advanceTimersByTimeAsync(31_000);

    expect(await screen.findByText('浏览器已关闭')).toBeDefined();
    expect(screen.queryByTestId('browser-takeover-park-continue')).toBeNull();
  });
  it('rechecks the window on Continue and does not send after it closes between polls', async () => {
    getKeptResultPage.mockResolvedValue({ state: 'kept', url: 'https://example.test', title: 'Sign in', reason: 'takeover' });
    const onContinue = vi.fn();
    render(<BrowserTakeoverParkCard conversationId="conversation-a" onContinue={onContinue} />);
    const button = await screen.findByTestId('browser-takeover-park-continue');
    getKeptResultPage.mockResolvedValue({ state: 'closed', url: 'https://example.test', title: 'Sign in', reason: 'takeover' });
    fireEvent.click(button);
    expect(await screen.findByText('浏览器已关闭')).toBeDefined();
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.queryByTestId('browser-takeover-park-continue')).toBeNull();
  });

  it('awaits sending and shows plain copy if sending fails, without exposing the error', async () => {
    getKeptResultPage.mockResolvedValue({ state: 'kept', url: 'https://example.test', title: 'Sign in', reason: 'takeover' });
    const onContinue = vi.fn().mockRejectedValue(new Error('INTERNAL_ROUTE /private/api'));
    render(<BrowserTakeoverParkCard conversationId="conversation-a" onContinue={onContinue} />);
    fireEvent.click(await screen.findByTestId('browser-takeover-park-continue'));
    expect(await screen.findByText('消息未能发送，请再试一次。')).toBeDefined();
    expect(screen.queryByText(/INTERNAL_ROUTE/)).toBeNull();
  });

  it('opens the retained window through the existing adoption route without sending Continue', async () => {
    getKeptResultPage.mockResolvedValue({ state: 'kept', url: 'https://example.test', title: 'Sign in', reason: 'takeover' });
    const onContinue = vi.fn();
    render(<BrowserTakeoverParkCard conversationId="conversation-a" workspace="/workspace" onContinue={onContinue} />);
    fireEvent.click(await screen.findByTestId('browser-takeover-park-open'));
    await waitFor(() => expect(adoptKeptResultPage).toHaveBeenCalledWith({ conversationId: 'conversation-a', workspace: '/workspace' }));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('sends the continuation in the conversation language even when the UI language differs', async () => {
    getKeptResultPage.mockResolvedValue({ state: 'kept', url: 'https://example.test', title: 'Sign in', reason: 'takeover' });
    const onContinue = vi.fn();
    render(<BrowserTakeoverParkCard conversationId="conversation-a" messageLanguage="en" onContinue={onContinue} />);
    fireEvent.click(await screen.findByTestId('browser-takeover-park-continue'));
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith('I have finished signing in in the browser window. Please continue the earlier task.'));
  });

  it('clears pendingClaim on poll when the next run did not consume the parked window so Open and Continue work again', async () => {
    getKeptResultPage.mockResolvedValue({
      state: 'kept',
      url: 'https://idp.example.test/login',
      title: 'Sign in',
      reason: 'takeover',
    });
    const onContinue = vi.fn();
    render(<BrowserTakeoverParkCard conversationId="conversation-a" workspace="/workspace" onContinue={onContinue} />);

    const openButton = await screen.findByTestId('browser-takeover-park-open');
    const continueButton = await screen.findByTestId('browser-takeover-park-continue');
    fireEvent.click(continueButton);

    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    expect((openButton as HTMLButtonElement).disabled).toBe(true);
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    await waitFor(() => {
      expect((openButton as HTMLButtonElement).disabled).toBe(false);
      expect((continueButton as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(openButton);
    await waitFor(() => expect(adoptKeptResultPage).toHaveBeenCalledWith({
      conversationId: 'conversation-a',
      workspace: '/workspace',
    }));

    fireEvent.click(continueButton);
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(2));
  });

  it('keeps actions disabled while the continuation turn runs and re-enables immediately when a non-browser turn finishes', async () => {
    getKeptResultPage.mockResolvedValue({
      state: 'kept',
      url: 'https://idp.example.test/login',
      title: 'Sign in',
      reason: 'takeover',
    });
    const onContinue = vi.fn(() => {
      act(() => {
        useTaskStore.getState().updateSessionState('conversation-a', {
          status: 'running',
          startTime: Date.now(),
        });
      });
      return true;
    });
    render(<BrowserTakeoverParkCard conversationId="conversation-a" onContinue={onContinue} />);

    const openButton = await screen.findByTestId('browser-takeover-park-open');
    const continueButton = await screen.findByTestId('browser-takeover-park-continue');
    fireEvent.click(continueButton);

    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    expect((openButton as HTMLButtonElement).disabled).toBe(true);
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);

    // Mid-run poll must NOT re-enable actions while the turn is still running.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect((openButton as HTMLButtonElement).disabled).toBe(true);
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);

    // Turn finishes with text only (browser was never touched, so kept entry remains).
    act(() => {
      useTaskStore.getState().updateSessionState('conversation-a', { status: 'idle' });
    });

    await waitFor(() => {
      expect((openButton as HTMLButtonElement).disabled).toBe(false);
      expect((continueButton as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('does not leave actions disabled when send settles into task error before starting a run', async () => {
    getKeptResultPage.mockResolvedValue({
      state: 'kept',
      url: 'https://idp.example.test/login',
      title: 'Sign in',
      reason: 'takeover',
    });
    const onContinue = vi.fn(() => {
      act(() => {
        useTaskStore.getState().updateSessionState('conversation-a', {
          status: 'error',
          error: 'HTTP 500',
        });
      });
      return true;
    });
    render(<BrowserTakeoverParkCard conversationId="conversation-a" onContinue={onContinue} />);

    const openButton = await screen.findByTestId('browser-takeover-park-open');
    const continueButton = await screen.findByTestId('browser-takeover-park-continue');
    fireEvent.click(continueButton);

    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect((openButton as HTMLButtonElement).disabled).toBe(false);
      expect((continueButton as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
