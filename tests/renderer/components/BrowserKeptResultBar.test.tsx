// @vitest-environment jsdom
// N-BROWSER-KEEP-RESULT-PAGE：终态结果页条三态（kept / closed / none）。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { MANAGED_BROWSER_DEFAULT_LEASE_TTL_MS } from '../../../src/host/services/infra/browser/managedBrowserHelpers';
import { keptResultReopenMode } from '../../../src/host/services/surfaceExecution/keptResultSnapshot';
import { workbenchTabsEn, workbenchTabsZh } from '../../../src/renderer/i18n/workbenchTabs';
import { BrowserKeptResultBar } from '../../../src/renderer/components/workbench/BrowserKeptResultBar';

const { getKeptResultPage, adoptKeptResultPage, openHttpLinkInRailAsync } = vi.hoisted(() => ({
  getKeptResultPage: vi.fn(),
  adoptKeptResultPage: vi.fn(),
  openHttpLinkInRailAsync: vi.fn(),
}));

vi.mock('../../../src/renderer/services/keptResultPage', () => ({
  getKeptResultPage: (conversationId: string, options?: { includeSnapshot?: boolean }) =>
    getKeptResultPage(conversationId, options),
  adoptKeptResultPage: (input: unknown) => adoptKeptResultPage(input),
}));

vi.mock('../../../src/renderer/services/userBrowserLink', () => ({
  openHttpLinkInRailAsync: (input: unknown) => openHttpLinkInRailAsync(input),
}));

beforeEach(() => {
  useSurfaceExecutionStore.getState().reset();
  useAppStore.getState().setLanguage('zh');
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

  it('reopen policy is snapshot only when html exists and the url has no query', () => {
    expect(keptResultReopenMode({
      url: 'http://127.0.0.1/signup-direct',
      snapshotHtml: '<h1>Signup success, Lee</h1>',
    })).toBe('snapshot');
    expect(keptResultReopenMode({
      url: 'http://127.0.0.1/done?id=1',
      snapshotHtml: '<h1>Signup success, Lee</h1>',
    })).toBe('url');
  });

  it('closed snapshot mode shows the saved page and does not navigate until the original address is tried', async () => {
    const html = '<html><body><h1>Signup success, Lee</h1></body></html>';
    getKeptResultPage.mockImplementation(async (_id: string, options?: { includeSnapshot?: boolean }) => ({
      state: 'closed',
      url: 'http://127.0.0.1/signup-direct',
      title: 'Signup success, Lee',
      reason: 'keep_result_page',
      reopenMode: 'snapshot',
      ...(options?.includeSnapshot ? { snapshotHtml: html } : {}),
    }));
    openHttpLinkInRailAsync.mockResolvedValue({ surfaceSessionId: 'surface-user' });
    render(<BrowserKeptResultBar conversationId="conversation-a" workspace="/tmp/w" />);

    expect(await screen.findByText(/重新打开会显示当时保存的页面，只能看。/)).toBeDefined();
    expect(screen.queryByText(/不恢复表单里已填的内容/)).toBeNull();
    fireEvent.click(await screen.findByTestId('browser-kept-result-reopen'));

    const frame = await screen.findByTestId('browser-kept-result-snapshot-frame');
    expect(frame.getAttribute('srcdoc')).toContain('Signup success, Lee');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('style')).toContain('pointer-events: none');
    expect(screen.getByTestId('browser-kept-result-snapshot-note').textContent)
      .toBe('这是 Neo 当时保存的页面，只能看，不能点或填写。');
    expect(openHttpLinkInRailAsync).not.toHaveBeenCalled();
    fireEvent.click(frame);
    expect(openHttpLinkInRailAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('browser-kept-result-snapshot-try-original'));
    await waitFor(() => expect(openHttpLinkInRailAsync).toHaveBeenCalledWith({
      href: 'http://127.0.0.1/signup-direct',
      conversationId: 'conversation-a',
      workspace: '/tmp/w',
    }));
  });

  it('shows the saved-copy note in English', async () => {
    useAppStore.getState().setLanguage('en');
    getKeptResultPage.mockImplementation(async (_id: string, options?: { includeSnapshot?: boolean }) => ({
      state: 'closed',
      url: 'http://127.0.0.1/done-flash',
      title: 'Signup success, Lee',
      reason: 'keep_result_page',
      reopenMode: 'snapshot',
      ...(options?.includeSnapshot ? { snapshotHtml: '<h1>Signup success, Lee</h1>' } : {}),
    }));
    render(<BrowserKeptResultBar conversationId="conversation-a" workspace="/tmp/w" />);

    expect(await screen.findByText(/Reopen shows the saved page \(read-only\)\./)).toBeDefined();
    fireEvent.click(await screen.findByTestId('browser-kept-result-reopen'));
    expect(await screen.findByText(/This is a saved copy of the page/)).toBeDefined();
    expect(screen.getByTestId('browser-kept-result-snapshot-try-original').textContent).toBe('Try the original address');
  });

  it('falls back to the URL when the snapshot fetch is empty or fails', async () => {
    getKeptResultPage.mockImplementation(async (_id: string, options?: { includeSnapshot?: boolean }) => {
      if (options?.includeSnapshot) throw new Error('ipc down');
      return {
        state: 'closed',
        url: 'http://127.0.0.1/signup-direct',
        title: 'Done',
        reason: 'keep_result_page',
        reopenMode: 'snapshot',
      };
    });
    openHttpLinkInRailAsync.mockResolvedValue({ surfaceSessionId: 'surface-user' });
    render(<BrowserKeptResultBar conversationId="conversation-a" workspace="/tmp/w" />);

    fireEvent.click(await screen.findByTestId('browser-kept-result-reopen'));
    await waitFor(() => expect(openHttpLinkInRailAsync).toHaveBeenCalledWith({
      href: 'http://127.0.0.1/signup-direct',
      conversationId: 'conversation-a',
      workspace: '/tmp/w',
    }));
    expect(screen.queryByTestId('browser-kept-result-snapshot-note')).toBeNull();
  });
});
