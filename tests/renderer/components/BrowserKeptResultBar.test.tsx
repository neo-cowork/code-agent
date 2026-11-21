// @vitest-environment jsdom
// N-BROWSER-KEEP-RESULT-PAGE：终态结果页条三态（kept / closed / none）。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import { MANAGED_BROWSER_DEFAULT_LEASE_TTL_MS } from '../../../src/host/services/infra/browser/managedBrowserHelpers';
import { workbenchTabsEn, workbenchTabsZh } from '../../../src/renderer/i18n/workbenchTabs';
import { BrowserKeptResultBar } from '../../../src/renderer/components/workbench/BrowserKeptResultBar';

const { getKeptResultPage, adoptKeptResultPage, openHttpLinkInRailAsync } = vi.hoisted(() => ({
  getKeptResultPage: vi.fn(),
  adoptKeptResultPage: vi.fn(),
  openHttpLinkInRailAsync: vi.fn(),
}));

vi.mock('../../../src/renderer/services/keptResultPage', () => ({
  getKeptResultPage: (conversationId: string) => getKeptResultPage(conversationId),
  adoptKeptResultPage: (input: unknown) => adoptKeptResultPage(input),
}));

vi.mock('../../../src/renderer/services/userBrowserLink', () => ({
  openHttpLinkInRailAsync: (input: unknown) => openHttpLinkInRailAsync(input),
}));

beforeEach(() => {
  useSurfaceExecutionStore.getState().reset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getKeptResultPage.mockReset();
  adoptKeptResultPage.mockReset();
  openHttpLinkInRailAsync.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BrowserKeptResultBar', () => {
  it('describes the lease duration and timer reset in both languages', () => {
    const minutes = MANAGED_BROWSER_DEFAULT_LEASE_TTL_MS / 60_000;
    expect(workbenchTabsZh.workbenchTabs.agentWindow.keptResult.keptHint)
      .toContain(`连续 ${minutes} 分钟没有任何操作，窗口会自动关闭。每次操作都会重新计时。`);
    expect(workbenchTabsEn.workbenchTabs.agentWindow.keptResult.keptHint)
      .toContain(`The window closes automatically after ${minutes} minutes without any activity. Any action restarts the timer.`);
  });

  it('renders nothing for state none', async () => {
    getKeptResultPage.mockResolvedValue({ state: 'none', url: null, title: null });
    const { container } = render(
      <BrowserKeptResultBar conversationId="conversation-a" workspace="/tmp/w" />,
    );
    await waitFor(() => expect(getKeptResultPage).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('kept state offers one-click adoption and calls adoptKeptResultPage', async () => {
    getKeptResultPage.mockResolvedValue({
      state: 'kept',
      url: 'https://example.test/result',
      title: 'Result',
    });
    adoptKeptResultPage.mockResolvedValue({ surfaceSessionId: 'surface-user' });
    render(<BrowserKeptResultBar conversationId="conversation-a" workspace="/tmp/w" />);

    const adopt = await screen.findByTestId('browser-kept-result-adopt');
    expect(screen.getByText('结果页已保留')).toBeDefined();
    expect(screen.getByText('Result')).toBeDefined();
    expect(screen.getByText(/连续 30 分钟没有任何操作/)).toBeDefined();
    fireEvent.click(adopt);

    await waitFor(() => expect(adoptKeptResultPage).toHaveBeenCalledWith({
      conversationId: 'conversation-a',
      workspace: '/tmp/w',
    }));
  });

  it('kept state surfaces an adoption failure without crashing', async () => {
    getKeptResultPage.mockResolvedValue({
      state: 'kept',
      url: 'https://example.test/result',
      title: 'Result',
    });
    adoptKeptResultPage.mockRejectedValue(new Error('window already reclaimed'));
    render(<BrowserKeptResultBar conversationId="conversation-a" workspace="/tmp/w" />);

    fireEvent.click(await screen.findByTestId('browser-kept-result-adopt'));

    await waitFor(() => expect(screen.getByText(/认领结果页失败/)).toBeDefined());
  });

  it('closed state says the page was closed and reopens the saved URL only', async () => {
    getKeptResultPage.mockResolvedValue({
      state: 'closed',
      url: 'https://example.test/result',
      title: 'Result',
    });
    openHttpLinkInRailAsync.mockResolvedValue({ surfaceSessionId: 'surface-user' });
    render(<BrowserKeptResultBar conversationId="conversation-a" workspace="/tmp/w" />);

    expect(await screen.findByText('结果页已关闭')).toBeDefined();
    expect(screen.getByText(/可能是因为有一段时间没人操作，或是浏览器被关了/)).toBeDefined();
    expect(screen.getByText(/不恢复表单里已填的内容/)).toBeDefined();
    fireEvent.click(await screen.findByTestId('browser-kept-result-reopen'));

    await waitFor(() => expect(openHttpLinkInRailAsync).toHaveBeenCalledWith({
      href: 'https://example.test/result',
      conversationId: 'conversation-a',
      workspace: '/tmp/w',
    }));
  });

  it('flips from kept to closed when the poll observes the idle reclaim', async () => {
    getKeptResultPage.mockResolvedValueOnce({
      state: 'kept',
      url: 'https://example.test/result',
      title: 'Result',
    }).mockResolvedValue({
      state: 'closed',
      url: 'https://example.test/result',
      title: 'Result',
    });
    render(<BrowserKeptResultBar conversationId="conversation-a" workspace="/tmp/w" />);

    expect(await screen.findByText('结果页已保留')).toBeDefined();
    await vi.advanceTimersByTimeAsync(31_000);

    expect(await screen.findByText('结果页已关闭')).toBeDefined();
    expect(screen.queryByTestId('browser-kept-result-adopt')).toBeNull();
  });
});
