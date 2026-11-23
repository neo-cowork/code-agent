// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore, type PreviewTab } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useArtifactFollowStore } from '../../../src/renderer/stores/artifactFollowStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

const sendPrompt = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: { sendPrompt: typeof sendPrompt }) => unknown) =>
    selector({ sendPrompt }),
}));

import {
  PreviewPanel,
  StaticHtmlPreview,
} from '../../../src/renderer/components/PreviewPanel';

import { ARTIFACT_PREVIEW_SANDBOX } from '../../../src/renderer/utils/previewFrameBridge';

const feedbackInput = '这里改成…（回车发送）';
const selectedButton = {
  type: 'neo-preview-selection',
  selector: 'html > body > main > button',
  tag: 'button',
  text: '开始规划行程',
};

function previewElement(iframeRef: React.RefObject<HTMLIFrameElement | null>, html = '<main><button>开始规划行程</button></main>') {
  return <StaticHtmlPreview html={html} filePath="/tmp/travel/prototype.html" iframeRef={iframeRef} title="HTML 预览" />;
}

function replyFromFrame(
  iframe: HTMLIFrameElement,
  data: object,
  source = iframe.contentWindow,
) {
  act(() => window.dispatchEvent(new MessageEvent('message', {
    origin: 'null',
    source,
    data: { revision: Number(iframe.dataset.previewRevision), ...data },
  })));
}

function loadedTab(overrides: Partial<PreviewTab>): PreviewTab {
  return {
    id: 'preview-test',
    path: '/tmp/prototype.html',
    content: '<button>开始规划行程</button>',
    savedContent: '<button>开始规划行程</button>',
    mode: 'preview',
    lastActivatedAt: 1,
    isLoaded: true,
    kind: 'file',
    ...overrides,
  };
}

beforeEach(() => {
  sendPrompt.mockClear();
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
  cleanup();
  useAppStore.setState({ previewTabs: [], activePreviewTabId: null });
});

describe('StaticHtmlPreview 圈选与反馈', () => {
  it('isolates the actual artifact iframe origin while preserving its interaction permissions', () => {
    const iframeRef = React.createRef<HTMLIFrameElement>();
    render(previewElement(iframeRef));

    const sandbox = iframeRef.current?.getAttribute('sandbox')?.split(/\s+/);
    expect(sandbox).not.toContain('allow-same-origin');
    expect(ARTIFACT_PREVIEW_SANDBOX.split(/\s+/)).not.toContain('allow-same-origin');
    expect(sandbox).toEqual(['allow-scripts', 'allow-forms', 'allow-popups', 'allow-pointer-lock']);
    expect(iframeRef.current?.getAttribute('allow')).toBe('fullscreen; gamepad; autoplay');
  });

  it('starts with selection disabled and drops unknown, oversized, malformed and unrelated messages', () => {
    const iframeRef = React.createRef<HTMLIFrameElement>();
    render(previewElement(iframeRef));
    const iframe = iframeRef.current!;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    fireEvent.load(iframe);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'neo-preview-select', on: false }, '*');
    replyFromFrame(iframe, selectedButton);
    expect(screen.queryByPlaceholderText(feedbackInput)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '圈选' }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'neo-preview-select', on: true }, '*');
    replyFromFrame(iframe, selectedButton, window);
    replyFromFrame(iframe, { ...selectedButton, type: 'other' });
    replyFromFrame(iframe, { ...selectedButton, text: 8 });
    replyFromFrame(iframe, { ...selectedButton, selector: 'a'.repeat(513) });
    expect(screen.queryByPlaceholderText(feedbackInput)).toBeNull();
  });

  it('shows selection feedback and submits the same selector before clearing the frame', async () => {
    const iframeRef = React.createRef<HTMLIFrameElement>();
    render(previewElement(iframeRef));
    const iframe = iframeRef.current!;
    await new Promise<void>((resolve) => iframe.addEventListener('load', () => resolve(), { once: true }));
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');
    fireEvent.click(screen.getByRole('button', { name: '圈选' }));
    replyFromFrame(iframe, selectedButton);

    const input = await screen.findByPlaceholderText(feedbackInput);
    expect(screen.getByText(/<button> 开始规划行程/)).not.toBeNull();
    fireEvent.change(input, { target: { value: '改成蓝色主按钮' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    const [message, context] = sendPrompt.mock.calls[0];
    expect(message).toContain('/tmp/travel/prototype.html');
    expect(message).toContain(selectedButton.selector);
    expect(context.localityAnchor.selector).toBe(selectedButton.selector);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(feedbackInput)).toBeNull();
    });
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'neo-preview-clear' }, '*');
  });

  it('clears on deselect, mode reset, and srcdoc replacement and ignores the retired frame', () => {
    const iframeRef = React.createRef<HTMLIFrameElement>();
    const { rerender } = render(previewElement(iframeRef));
    const iframe = iframeRef.current!;
    const oldWindow = iframe.contentWindow;
    const toggle = screen.getByRole('button', { name: '圈选' });
    fireEvent.click(toggle);
    replyFromFrame(iframe, selectedButton);
    expect(screen.getByPlaceholderText(feedbackInput)).toBeTruthy();
    replyFromFrame(iframe, { type: 'neo-preview-selection-cleared' });
    expect(screen.queryByPlaceholderText(feedbackInput)).toBeNull();

    replyFromFrame(iframe, selectedButton);
    fireEvent.click(screen.getByRole('button', { name: '取消选中' }));
    expect(screen.queryByPlaceholderText(feedbackInput)).toBeNull();
    replyFromFrame(iframe, selectedButton);
    fireEvent.click(toggle);
    expect(screen.queryByPlaceholderText(feedbackInput)).toBeNull();
    fireEvent.click(toggle);
    replyFromFrame(iframe, selectedButton);

    rerender(previewElement(iframeRef, '<button>新按钮</button>'));
    expect(screen.queryByPlaceholderText(feedbackInput)).toBeNull();
    const replacement = iframeRef.current!;
    expect(replacement).not.toBe(iframe);
    replyFromFrame(replacement, selectedButton, oldWindow);
    expect(screen.queryByPlaceholderText(feedbackInput)).toBeNull();

    const postMessage = vi.spyOn(replacement.contentWindow!, 'postMessage');
    fireEvent.load(replacement);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'neo-preview-select', on: true }, '*');
    replyFromFrame(replacement, { ...selectedButton, text: '新按钮' });
    expect(screen.getByText(/<button> 新按钮/)).not.toBeNull();
  });
});

describe('PreviewPanel 非 HTML 分支', () => {
  // 🔴 文案是产品决策：爸 2026-08-18 拍板右栏这几句换人话（原「已验证/未验证」是内部术语，
  // 与 #1234 卡面撤徽章同一理由）。要改回内部术语必须先拿新拍板并在 PR 里引用单号。
  it.each([
    ['verified', '已就绪'],
    ['unverified', '未检查'],
  ] as const)('右侧面板如实显示 %s 产物状态', (deliverableStatus, label) => {
    const tab = loadedTab({
      path: '/tmp/report.md',
      content: '# report',
      savedContent: '# report',
      deliverableStatus,
    });
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });

    render(<PreviewPanel />);

    expect(screen.getByTestId('preview-deliverable-status').textContent).toContain(label);
  });

  it('有真实图片 tab 时渲染图片，不挂 srcdoc 选择面或反馈栏', () => {
    const tab = loadedTab({
      path: '/tmp/cover.png',
      content: 'data:image/png;base64,AA==',
      savedContent: 'data:image/png;base64,AA==',
    });
    useAppStore.setState({
      previewTabs: [tab],
      activePreviewTabId: tab.id,
    });

    const { container } = render(<PreviewPanel />);

    expect(container.querySelector('img[alt="/tmp/cover.png"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="static-html-preview"]')).toBeNull();
    expect(screen.queryByPlaceholderText('这里改成…（回车发送）')).toBeNull();
  });
});

describe('PreviewPanel 三态工具栏', () => {
  it('轮终态到达后立即收掉生成中，哪怕 artifact follow 事件仍滞留 generating', () => {
    const tab = loadedTab({ path: '/tmp/report.html', content: '<main>report</main>' });
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });
    useSessionStore.setState({ currentSessionId: 'session-terminal', runningSessionIds: new Set(['session-terminal']) });
    useArtifactFollowStore.getState().start({ sessionId: 'session-terminal', path: tab.path, attention: false });
    const view = render(<PreviewPanel />);
    expect(screen.getByTestId('artifact-follow-generating')).toBeTruthy();

    act(() => useSessionStore.setState({ runningSessionIds: new Set() }));
    expect(screen.queryByTestId('artifact-follow-generating')).toBeNull();
    expect(view.container.textContent).not.toContain('生成中 · 内容跟随刷新');
  });

  it('HTML 可在预览、只读源码、编辑三态间切换', async () => {
    const tab = loadedTab({
      path: '/tmp/report.html',
      content: '<main>report</main>',
      savedContent: '<main>report</main>',
    });
    useAppStore.setState({ previewTabs: [tab], activePreviewTabId: tab.id });
    render(<PreviewPanel />);

    fireEvent.click(screen.getByTestId('preview-mode-source'));
    expect(useAppStore.getState().previewTabs[0].mode).toBe('source');
    await waitFor(() => {
      expect(screen.getByTestId('preview-mode-source').getAttribute('aria-pressed')).toBe('true');
    });

    fireEvent.click(screen.getByTestId('preview-mode-edit'));
    expect(useAppStore.getState().previewTabs[0].mode).toBe('edit');
    fireEvent.click(screen.getByTestId('preview-mode-preview'));
    expect(useAppStore.getState().previewTabs[0].mode).toBe('preview');
  });
});
