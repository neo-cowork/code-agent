// @vitest-environment jsdom
// N-FIX-FIX-BROWSER-SECRETREF-HARDEN（FB-578）：secretRef 接管停靠的聊天卡三态
// （takeover+kept / takeover+closed / 其他不渲染）+「继续」发送用户消息。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserTakeoverParkCard } from '../../../../src/renderer/components/features/surfaceExecution/BrowserTakeoverParkCard';

const { getKeptResultPage } = vi.hoisted(() => ({
  getKeptResultPage: vi.fn(),
}));

vi.mock('../../../../src/renderer/services/userBrowserLink', () => ({
  getKeptResultPage: (conversationId: string) => getKeptResultPage(conversationId),
}));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getKeptResultPage.mockReset();
});

afterEach(() => {
  cleanup();
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
});
