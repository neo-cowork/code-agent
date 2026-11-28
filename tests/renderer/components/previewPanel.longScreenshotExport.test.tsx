// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PREVIEW_CAPTURE_TIMEOUTS } from '@shared/constants/timeouts';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore, type PreviewTab } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useArtifactFollowStore } from '../../../src/renderer/stores/artifactFollowStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { ToastContainer } from '../../../src/renderer/components/Toast';
import { usePreviewLongScreenshotExport } from '../../../src/renderer/hooks/usePreviewLongScreenshotExport';

const sendPrompt = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: { sendPrompt: typeof sendPrompt }) => unknown) =>
    selector({ sendPrompt }),
}));

vi.mock('html2canvas/dist/html2canvas.js?raw', () => ({ default: '    return html2canvas;' }));

import { PreviewPanel } from '../../../src/renderer/components/PreviewPanel';

const VALID_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VALID_PNG_DATA_URL = `data:image/png;base64,${VALID_PNG_BASE64}`;

type DomainInvokeFn = (domain: string, action: string, payload?: unknown) => Promise<unknown>;

const domainInvoke = vi.fn<DomainInvokeFn>();

function loadedTab(overrides: Partial<PreviewTab> = {}): PreviewTab {
  return {
    id: 'preview-export-test',
    path: '/tmp/reports/coffee-inventory.html',
    content: '<main><h1>咖啡店周度库存表</h1><table><tr><td>耶加雪菲</td><td>18 kg</td></tr></table></main>',
    savedContent: '<main><h1>咖啡店周度库存表</h1><table><tr><td>耶加雪菲</td><td>18 kg</td></tr></table></main>',
    mode: 'preview',
    lastActivatedAt: 1,
    isLoaded: true,
    kind: 'file',
    ...overrides,
  };
}

function replyFromFrame(
  iframe: HTMLIFrameElement,
  data: object,
  source = iframe.contentWindow,
) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'null',
      source,
      data: { revision: Number(iframe.dataset.previewRevision), ...data },
    }));
  });
}

function openMoreActionsAndClickExport() {
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
  fireEvent.click(screen.getByRole('button', { name: '导出长图' }));
}

function setupDefaultDomainMock(
  overrides: Partial<{
    saveBinaryToDownloads: (payload: unknown) => Promise<unknown>;
  }> = {},
) {
  domainInvoke.mockImplementation(async (domain, action, payload) => {
    if (domain === IPC_DOMAINS.WORKSPACE && action === 'getPublishInfo') {
      return { success: true, data: { publishState: { kind: 'draft' }, publishedVersions: [] } };
    }
    if (domain === IPC_DOMAINS.WORKSPACE && action === 'getFileMetadata') {
      return { success: true, data: null };
    }
    if (domain === IPC_DOMAINS.WORKSPACE && action === 'saveBinaryToDownloads') {
      if (overrides.saveBinaryToDownloads) {
        return overrides.saveBinaryToDownloads(payload);
      }
      const { fileName } = payload as { fileName: string; base64: string };
      return { success: true, data: { filePath: `/tmp/Downloads/${fileName}` } };
    }
    if (domain === IPC_DOMAINS.WORKSPACE && action === 'showItemInFolder') {
      return { success: true, data: { ok: true } };
    }
    if (domain === IPC_DOMAINS.DIAGNOSTICS && action === 'logClientError') {
      return { success: true, data: { logged: true } };
    }
    return { success: true, data: null };
  });
}

function getLogClientErrorPayloads() {
  return domainInvoke.mock.calls
    .filter(([domain, action]) => domain === IPC_DOMAINS.DIAGNOSTICS && action === 'logClientError')
    .map(([, , payload]) => payload as { context?: string; message?: string; detail?: string });
}

function getSaveBinaryCalls() {
  return domainInvoke.mock.calls
    .filter(([domain, action]) => domain === IPC_DOMAINS.WORKSPACE && action === 'saveBinaryToDownloads')
    .map(([, , payload]) => payload as { fileName: string; base64: string });
}

function getScreenshotPostMessages(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map(([msg]) => msg as { type?: string; id?: number })
    .filter((msg) => msg?.type === 'neo-preview-screenshot');
}

beforeEach(() => {
  sendPrompt.mockClear();
  domainInvoke.mockReset();
  setupDefaultDomainMock();
  (window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__ = {};
  (window as unknown as { domainAPI?: { invoke: DomainInvokeFn } }).domainAPI = {
    invoke: domainInvoke,
  };
  useToastStore.setState({ toasts: [] });
  useAppStore.setState({
    previewTabs: [],
    activePreviewTabId: null,
    language: 'zh',
    processingSessionIds: new Set(),
  });
  useSessionStore.setState({ currentSessionId: null, runningSessionIds: new Set() });
  useTaskStore.setState({ sessionStates: {} });
  useArtifactFollowStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as unknown as { domainAPI?: unknown }).domainAPI;
  useToastStore.setState({ toasts: [] });
  useAppStore.setState({ previewTabs: [], activePreviewTabId: null });
});

describe('PreviewPanel 长图导出 (host Downloads + toast + logClientError)', () => {
  it('Tauri 壳下走 saveBinaryToDownloads 落盘，不触发 a[download]/createObjectURL，toast 动作调用 showItemInFolder', async () => {
    const tab = loadedTab();
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });

    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL');

    const { container } = render(
      <>
        <PreviewPanel />
        <ToastContainer />
      </>,
    );

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    const postMessageSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    openMoreActionsAndClickExport();

    await waitFor(() => {
      expect(getScreenshotPostMessages(postMessageSpy)).toHaveLength(1);
    });
    expect(screen.getByText('正在生成长图…')).toBeTruthy();

    const [{ id }] = getScreenshotPostMessages(postMessageSpy);
    replyFromFrame(iframe, {
      type: 'neo-preview-screenshot-done',
      id,
      png: VALID_PNG_DATA_URL,
    });

    await waitFor(() => {
      expect(getSaveBinaryCalls()).toHaveLength(1);
    });

    expect(getSaveBinaryCalls()[0]).toEqual({
      fileName: 'coffee-inventory-long-screenshot.png',
      base64: VALID_PNG_BASE64,
    });
    expect(anchorClickSpy).not.toHaveBeenCalled();
    expect(createObjectUrlSpy).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(
        screen.getByText('长图已保存到「下载」文件夹：coffee-inventory-long-screenshot.png'),
      ).toBeTruthy();
    });
    expect(screen.queryByText('正在生成长图…')).toBeNull();

    const revealButton = screen.getByRole('button', { name: '在访达中显示' });
    fireEvent.click(revealButton);

    await waitFor(() => {
      expect(domainInvoke).toHaveBeenCalledWith(
        IPC_DOMAINS.WORKSPACE,
        'showItemInFolder',
        { filePath: '/tmp/Downloads/coffee-inventory-long-screenshot.png' },
      );
    });
    expect(getLogClientErrorPayloads()).toHaveLength(0);
  });

  it('frame 回答后即使预览 iframe 被替换，仍完成保存并弹出成功提示', async () => {
    const tab = loadedTab();
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });

    let resolveSave!: (value: unknown) => void;
    setupDefaultDomainMock({
      saveBinaryToDownloads: () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    });

    const { container } = render(
      <>
        <PreviewPanel />
        <ToastContainer />
      </>,
    );

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    openMoreActionsAndClickExport();

    await waitFor(() => {
      expect(getScreenshotPostMessages(postMessageSpy)).toHaveLength(1);
    });
    const [{ id }] = getScreenshotPostMessages(postMessageSpy);
    replyFromFrame(iframe, {
      type: 'neo-preview-screenshot-done',
      id,
      png: VALID_PNG_DATA_URL,
    });

    await waitFor(() => {
      expect(getSaveBinaryCalls()).toHaveLength(1);
    });

    // Replace the iframe after the frame already answered
    act(() => {
      useAppStore.getState().updatePreviewTabMode(tab.id, 'source');
    });
    expect(container.querySelector('iframe')).toBeNull();

    act(() => {
      resolveSave({
        success: true,
        data: { filePath: '/tmp/Downloads/coffee-inventory-long-screenshot-1.png' },
      });
    });

    await waitFor(() => {
      expect(
        screen.getByText('长图已保存到「下载」文件夹：coffee-inventory-long-screenshot-1.png'),
      ).toBeTruthy();
    });
  });

  it('cors 失败给出跨域人话提示、保持预览不消失并写 PreviewExport reason=cross-origin 日志', async () => {
    const tab = loadedTab();
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });

    const { container } = render(
      <>
        <PreviewPanel />
        <ToastContainer />
      </>,
    );
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    openMoreActionsAndClickExport();
    await waitFor(() => expect(getScreenshotPostMessages(postMessageSpy)).toHaveLength(1));

    const [{ id }] = getScreenshotPostMessages(postMessageSpy);
    replyFromFrame(iframe, { type: 'neo-preview-screenshot-done', id, failure: 'cors' });

    await waitFor(() => {
      expect(
        screen.getByText('页面用了其他网站的图片或字体，生成不了长图。可以让 Neo 把它们存到本地后再导出'),
      ).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="static-html-preview"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(getSaveBinaryCalls()).toHaveLength(0);

    await waitFor(() => expect(getLogClientErrorPayloads()).toHaveLength(1));
    expect(getLogClientErrorPayloads()[0]).toMatchObject({
      context: 'PreviewExport',
      message: 'Long screenshot not saved: reason=cross-origin file=coffee-inventory.html',
    });
  });

  it('capture 失败给出人话提示、保持预览并写 reason=capture-failed 日志', async () => {
    const tab = loadedTab();
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });

    const { container } = render(
      <>
        <PreviewPanel />
        <ToastContainer />
      </>,
    );
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    openMoreActionsAndClickExport();
    await waitFor(() => expect(getScreenshotPostMessages(postMessageSpy)).toHaveLength(1));

    const [{ id }] = getScreenshotPostMessages(postMessageSpy);
    replyFromFrame(iframe, { type: 'neo-preview-screenshot-done', id, failure: 'capture' });

    await waitFor(() => {
      expect(screen.getByText('生成长图失败，请刷新预览后再试')).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="static-html-preview"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();

    await waitFor(() => expect(getLogClientErrorPayloads()).toHaveLength(1));
    expect(getLogClientErrorPayloads()[0]).toMatchObject({
      context: 'PreviewExport',
      message: 'Long screenshot not saved: reason=capture-failed file=coffee-inventory.html',
    });
  });

  it('超时给出超时提示、保持预览并写 reason=timeout 日志', async () => {
    vi.useFakeTimers();
    const tab = loadedTab();
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });

    const { container } = render(
      <>
        <PreviewPanel />
        <ToastContainer />
      </>,
    );
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    openMoreActionsAndClickExport();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getScreenshotPostMessages(postMessageSpy)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ARTIFACT_PREVIEW_CAPTURE_TIMEOUTS.RESPONSE);
    });

    expect(
      screen.getByText('生成长图超时，页面可能太长或还在加载，请稍后再试'),
    ).toBeTruthy();
    expect(container.querySelector('[data-testid="static-html-preview"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(getSaveBinaryCalls()).toHaveLength(0);
    expect(getLogClientErrorPayloads()).toHaveLength(1);
    expect(getLogClientErrorPayloads()[0]).toMatchObject({
      context: 'PreviewExport',
      message: 'Long screenshot not saved: reason=timeout file=coffee-inventory.html',
    });
  });

  it('捕获期间 iframe 重新加载给出 preview-changed 提示、保持预览并写日志', async () => {
    const tab = loadedTab();
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });

    const { container } = render(
      <>
        <PreviewPanel />
        <ToastContainer />
      </>,
    );
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    openMoreActionsAndClickExport();
    await waitFor(() => expect(getScreenshotPostMessages(postMessageSpy)).toHaveLength(1));

    fireEvent.load(iframe);

    await waitFor(() => {
      expect(screen.getByText('生成时预览内容变了，请再导出一次')).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="static-html-preview"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();

    await waitFor(() => expect(getLogClientErrorPayloads()).toHaveLength(1));
    expect(getLogClientErrorPayloads()[0]).toMatchObject({
      context: 'PreviewExport',
      message: 'Long screenshot not saved: reason=preview-changed file=coffee-inventory.html',
    });
  });

  it('捕获期间更新 HTML 替换 iframe，立即给出 preview-changed 提示并恢复导出', async () => {
    const tab = loadedTab();
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });

    const { container } = render(
      <>
        <PreviewPanel />
        <ToastContainer />
      </>,
    );
    const iframe = container.querySelector('iframe')!;
    const revision = iframe.dataset.previewRevision;
    const postMessageSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    openMoreActionsAndClickExport();
    await waitFor(() => expect(getScreenshotPostMessages(postMessageSpy)).toHaveLength(1));

    await act(async () => {
      useAppStore.getState().markPreviewTabLoaded(tab.id, '<main>已更新的库存表</main>');
    });
    expect(iframe.isConnected).toBe(false);
    const replacement = container.querySelector('iframe')!;
    expect(replacement.dataset.previewRevision).not.toBe(revision);

    expect(await screen.findByText('生成时预览内容变了，请再导出一次')).toBeTruthy();
    expect(screen.queryByText('正在生成长图…')).toBeNull();
    expect(getLogClientErrorPayloads()).toEqual([
      expect.objectContaining({
        context: 'PreviewExport',
        message: 'Long screenshot not saved: reason=preview-changed file=coffee-inventory.html',
      }),
    ]);
    expect(getSaveBinaryCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '导出长图' }).disabled).toBe(false);
  });

  it('saveBinaryToDownloads 返回 success:false 给出磁盘保存提示、保持预览并写 reason=save-failed 日志', async () => {
    setupDefaultDomainMock({
      saveBinaryToDownloads: async () => ({
        success: false,
        error: { code: 'DISK_FULL', message: 'No space left on device' },
      }),
    });
    const tab = loadedTab();
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });

    const { container } = render(
      <>
        <PreviewPanel />
        <ToastContainer />
      </>,
    );
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    openMoreActionsAndClickExport();
    await waitFor(() => expect(getScreenshotPostMessages(postMessageSpy)).toHaveLength(1));

    const [{ id }] = getScreenshotPostMessages(postMessageSpy);
    replyFromFrame(iframe, {
      type: 'neo-preview-screenshot-done',
      id,
      png: VALID_PNG_DATA_URL,
    });

    await waitFor(() => {
      expect(
        screen.getByText('长图没能存进「下载」文件夹，请检查磁盘空间后重试'),
      ).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="static-html-preview"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();

    await waitFor(() => expect(getLogClientErrorPayloads()).toHaveLength(1));
    expect(getLogClientErrorPayloads()[0]).toMatchObject({
      context: 'PreviewExport',
      message: 'Long screenshot not saved: reason=save-failed file=coffee-inventory.html',
      detail: 'No space left on device',
    });
  });

  it('源码模式下点击导出长图给出切回预览提示并写 reason=source-mode 日志', async () => {
    const tab = loadedTab({ mode: 'source' });
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });

    render(
      <>
        <PreviewPanel />
        <ToastContainer />
      </>,
    );

    openMoreActionsAndClickExport();

    await waitFor(() => {
      expect(screen.getByText('请先切回「预览」再导出长图')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(getSaveBinaryCalls()).toHaveLength(0);

    await waitFor(() => expect(getLogClientErrorPayloads()).toHaveLength(1));
    expect(getLogClientErrorPayloads()[0]).toMatchObject({
      context: 'PreviewExport',
      message: 'Long screenshot not saved: reason=source-mode file=coffee-inventory.html',
    });
  });

  it('无预览 iframe 时给出未就绪提示并写 reason=not-ready 日志', async () => {
    const iframeRef = { current: null as HTMLIFrameElement | null };
    const { result } = renderHook(() =>
      usePreviewLongScreenshotExport({
        iframeRef,
        previewFilePath: '/tmp/reports/coffee-inventory.html',
        isHtml: true,
        mode: 'preview',
      }),
    );

    render(<ToastContainer />);

    await act(async () => {
      await result.current.handleExportLongScreenshot();
    });

    await waitFor(() => {
      expect(screen.getByText('预览还没加载完，请稍后再导出')).toBeTruthy();
    });
    expect(getSaveBinaryCalls()).toHaveLength(0);

    await waitFor(() => expect(getLogClientErrorPayloads()).toHaveLength(1));
    expect(getLogClientErrorPayloads()[0]).toMatchObject({
      context: 'PreviewExport',
      message: 'Long screenshot not saved: reason=not-ready file=coffee-inventory.html',
    });
  });

  it('进行中菜单项禁用，且 frame 回复前连调两次只发一次截屏消息与一次保存', async () => {
    const tab = loadedTab();
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });

    const { container } = render(
      <>
        <PreviewPanel />
        <ToastContainer />
      </>,
    );
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    openMoreActionsAndClickExport();
    await waitFor(() => expect(getScreenshotPostMessages(postMessageSpy)).toHaveLength(1));

    // Reopen menu while exporting: button must be disabled
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    const exportBtn = screen.getByRole('button', { name: '导出长图' }) as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(true);

    const [{ id }] = getScreenshotPostMessages(postMessageSpy);
    replyFromFrame(iframe, {
      type: 'neo-preview-screenshot-done',
      id,
      png: VALID_PNG_DATA_URL,
    });
    await waitFor(() => expect(getSaveBinaryCalls()).toHaveLength(1));

    // Direct ref-guard verification: two synchronous calls before frame replies
    postMessageSpy.mockClear();
    domainInvoke.mockClear();
    setupDefaultDomainMock();

    const iframeRef = { current: iframe };
    const { result } = renderHook(() =>
      usePreviewLongScreenshotExport({
        iframeRef,
        previewFilePath: '/tmp/reports/coffee-inventory.html',
        isHtml: true,
        mode: 'preview',
      }),
    );

    let firstCall!: Promise<void>;
    let secondCall!: Promise<void>;
    act(() => {
      firstCall = result.current.handleExportLongScreenshot();
      secondCall = result.current.handleExportLongScreenshot();
    });

    await waitFor(() => expect(getScreenshotPostMessages(postMessageSpy)).toHaveLength(1));
    const [{ id: guardedId }] = getScreenshotPostMessages(postMessageSpy);
    replyFromFrame(iframe, {
      type: 'neo-preview-screenshot-done',
      id: guardedId,
      png: VALID_PNG_DATA_URL,
    });

    await act(async () => {
      await Promise.all([firstCall, secondCall]);
    });

    expect(getScreenshotPostMessages(postMessageSpy)).toHaveLength(1);
    expect(getSaveBinaryCalls()).toHaveLength(1);
  });
});
